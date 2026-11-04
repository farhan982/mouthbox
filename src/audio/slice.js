/* Cutting a take into individual hits, and measuring what each one sounds like.
 *
 * The measurements here are what the classifier clusters on, so they are all
 * things that separate mouth percussion: how bright it is, how noisy, how
 * fast it dies, how much of it is sub-bass.
 */

import { magnitudes, hann } from './fft.js';

const PRE_ROLL_MS = 6;     // keep the very front of the attack
const MAX_LEN_MS = 900;
const MIN_LEN_MS = 70;
const RELEASE_MS = 18;     // tail kept after the hit has died away
const FADE_IN_MS = 1.5;
const FADE_OUT_MS = 12;

function rmsEnvelope(samples, win) {
  const steps = Math.max(1, Math.floor(samples.length / win));
  const out = new Float32Array(steps);
  for (let s = 0; s < steps; s++) {
    let sum = 0;
    const start = s * win;
    const end = Math.min(samples.length, start + win);
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    out[s] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return out;
}

/* Where this hit stops being audible, as a sample offset from its start. */
function findTail(samples, sampleRate) {
  const win = Math.max(1, Math.round(sampleRate * 0.002));
  const env = rmsEnvelope(samples, win);
  let peak = 0;
  for (const v of env) if (v > peak) peak = v;
  if (peak <= 0) return samples.length;

  const cutoff = peak * 0.03;              // ~ -30 dB from the hit's own peak
  const need = Math.ceil(0.02 / 0.002);    // must stay quiet for 20 ms
  let quiet = 0;
  for (let s = 0; s < env.length; s++) {
    if (env[s] < cutoff) {
      if (++quiet >= need) return (s - need + 1) * win;
    } else {
      quiet = 0;
    }
  }
  return samples.length;
}

/* Spectral and envelope measurements for one hit.
 *
 * The spectrum is averaged over the whole hit rather than taken from the
 * attack alone. A kick's first 40 ms is mostly lip transient, which reads as
 * bright; what makes it a kick is the body that follows.
 */
export function features(samples, sampleRate) {
  const n = 2048;
  const hop = n / 2;
  const window = hann(n);
  const bins = n / 2 + 1;
  const mag = new Float32Array(bins);
  const frame = new Float32Array(n);
  const scratch = new Float32Array(bins);

  let frames = 0;
  for (let offset = 0; offset === 0 || offset + n <= samples.length; offset += hop) {
    frame.fill(0);
    const take = Math.min(n, samples.length - offset);
    if (take <= 0) break;
    for (let i = 0; i < take; i++) frame[i] = samples[offset + i];
    magnitudes(frame, window, scratch);
    for (let i = 0; i < bins; i++) mag[i] += scratch[i];
    frames++;
  }
  if (frames > 1) for (let i = 0; i < bins; i++) mag[i] /= frames;

  const binHz = sampleRate / n;
  let total = 0;
  let weighted = 0;
  let low = 0;      // < 250 Hz
  let mid = 0;      // 250 Hz – 5 kHz
  let high = 0;     // > 5 kHz
  let logSum = 0;
  let counted = 0;

  for (let i = 1; i < mag.length; i++) {
    const hz = i * binHz;
    const m = mag[i];
    total += m;
    weighted += m * hz;
    if (hz < 250) low += m;
    else if (hz < 5000) mid += m;
    else high += m;
    logSum += Math.log(m + 1e-9);
    counted++;
  }

  const centroid = total > 0 ? weighted / total : 0;

  // Flatness separates noise (snares, hats) from pitched sounds (hums, bass).
  const geo = Math.exp(logSum / counted);
  const arith = total / counted;
  const flatness = arith > 0 ? geo / arith : 0;

  // 85 % spectral rolloff: a second brightness measure, robust to a stray
  // loud fundamental pulling the centroid down.
  let acc = 0;
  let rolloff = 0;
  for (let i = 1; i < mag.length; i++) {
    acc += mag[i];
    if (acc >= total * 0.85) { rolloff = i * binHz; break; }
  }

  let crossings = 0;
  const zcrLen = Math.min(1024, samples.length - 1);
  for (let i = 0; i < zcrLen; i++) {
    if ((samples[i] >= 0) !== (samples[i + 1] >= 0)) crossings++;
  }
  const zcr = zcrLen > 0 ? crossings / zcrLen : 0;

  // Decay: how long until the hit drops 20 dB below its own peak.
  const win = Math.max(1, Math.round(sampleRate * 0.002));
  const env = rmsEnvelope(samples, win);
  let peak = 0;
  let peakAt = 0;
  for (let s = 0; s < env.length; s++) if (env[s] > peak) { peak = env[s]; peakAt = s; }
  let decaySteps = env.length - peakAt;
  for (let s = peakAt; s < env.length; s++) {
    if (env[s] < peak * 0.1) { decaySteps = s - peakAt; break; }
  }
  const decayMs = (decaySteps * win * 1000) / sampleRate;

  // Attack: how long the sound takes to reach its own peak. This is the
  // sharpest line between percussion and breathing — a hit is there almost
  // immediately, a breath swells.
  const attackMs = (peakAt * win * 1000) / sampleRate;

  // Crest factor: peak over RMS. Percussive sounds are spiky and score high;
  // breaths and room noise are flat and score low.
  let squared = 0;
  let absPeak = 0;
  for (let i = 0; i < samples.length; i++) {
    squared += samples[i] * samples[i];
    const a = Math.abs(samples[i]);
    if (a > absPeak) absPeak = a;
  }
  const rms = Math.sqrt(squared / Math.max(1, samples.length));
  const crest = rms > 0 ? absPeak / rms : 0;

  return {
    centroid,
    rolloff,
    flatness,
    zcr,
    lowRatio: total > 0 ? low / total : 0,
    midRatio: total > 0 ? mid / total : 0,
    highRatio: total > 0 ? high / total : 0,
    decayMs,
    attackMs,
    crest,
    durationMs: (samples.length * 1000) / sampleRate,
    peak,
  };
}

/* Splits a take into hits at the given onset frames.
 *
 * Each hit is normalised so pads sound even, but the original peak is kept so
 * the derived pattern can reproduce the dynamics that were performed.
 */
export function sliceTake(samples, sampleRate, onsets, timeOf) {
  const preRoll = Math.round((PRE_ROLL_MS / 1000) * sampleRate);
  const maxLen = Math.round((MAX_LEN_MS / 1000) * sampleRate);
  const minLen = Math.round((MIN_LEN_MS / 1000) * sampleRate);
  const release = Math.round((RELEASE_MS / 1000) * sampleRate);
  const fadeIn = Math.round((FADE_IN_MS / 1000) * sampleRate);
  const fadeOut = Math.round((FADE_OUT_MS / 1000) * sampleRate);

  const hits = [];

  for (let i = 0; i < onsets.length; i++) {
    const onsetTime = timeOf(onsets[i].frame);
    const start = Math.max(0, Math.round(onsetTime * sampleRate) - preRoll);

    const nextStart = i + 1 < onsets.length
      ? Math.round(timeOf(onsets[i + 1].frame) * sampleRate) - preRoll
      : samples.length;

    // Read past the next onset to measure the tail, but never play into it.
    const probeEnd = Math.min(samples.length, start + maxLen);
    const probe = samples.subarray(start, probeEnd);
    const tail = findTail(probe, sampleRate);

    let end = Math.min(start + tail + release, nextStart, start + maxLen);
    if (end - start < minLen) end = Math.min(start + minLen, samples.length, nextStart);
    if (end <= start) continue;

    const buf = new Float32Array(end - start);
    buf.set(samples.subarray(start, end));

    let peak = 0;
    for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; }
    if (peak < 1e-4) continue; // detected an onset, but there's nothing there

    const gain = 0.89 / peak; // normalise to about -1 dBFS
    for (let s = 0; s < buf.length; s++) buf[s] *= gain;

    for (let s = 0; s < Math.min(fadeIn, buf.length); s++) buf[s] *= s / fadeIn;
    for (let s = 0; s < Math.min(fadeOut, buf.length); s++) {
      buf[buf.length - 1 - s] *= s / fadeOut;
    }

    hits.push({
      index: hits.length,
      time: start / sampleRate,
      samples: buf,
      sampleRate,
      originalPeak: peak,
      // How hard the detector saw this onset, relative to the take's hardest.
      strength: onsets[i].strength ?? 1,
      features: features(buf, sampleRate),
    });
  }

  return hits;
}
