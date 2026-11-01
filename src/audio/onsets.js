/* Finding the hits in a take.
 *
 * Spectral flux rather than plain energy: a hat landing in the tail of a kick
 * barely moves the envelope but shows up clearly as new high-frequency
 * content, and beatboxers do that constantly.
 */

import { magnitudes, hann } from './fft.js';

export const FRAME = 1024;
export const HOP = 256;

/* Onset-strength envelope, one value per hop. */
export function onsetEnvelope(samples, sampleRate) {
  const window = hann(FRAME);
  const bins = FRAME / 2 + 1;
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const flux = new Float32Array(frames);

  let prev = new Float32Array(bins);
  let mag = new Float32Array(bins);
  const frame = new Float32Array(FRAME);

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FRAME; i++) frame[i] = samples[offset + i];
    magnitudes(frame, window, mag);

    let sum = 0;
    for (let i = 0; i < bins; i++) {
      // Log compression keeps a loud kick from drowning out a quiet rimshot.
      const d = Math.log1p(mag[i] * 8) - Math.log1p(prev[i] * 8);
      if (d > 0) sum += d;
    }
    flux[f] = sum;

    const swap = prev;
    prev = mag;
    mag = swap;
  }

  return {
    flux,
    hop: HOP,
    frameRate: sampleRate / HOP,
    timeOf: (f) => (f * HOP + FRAME / 2) / sampleRate,
  };
}

function smooth(x) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = x[i - 1] ?? x[i];
    const b = x[i];
    const c = x[i + 1] ?? x[i];
    out[i] = (a + 2 * b + c) / 4;
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* Peak-picks the envelope into onset frame indices.
 *
 * sensitivity rides the adaptive threshold: 0 catches ghost notes and room
 * noise, 1 only catches the obvious hits. 0.5 is the default in the UI.
 */
export function pickOnsets(env, { sensitivity = 0.5, minGapMs = 50 } = {}) {
  const flux = smooth(env.flux);
  const n = flux.length;
  if (!n) return [];

  const minGap = Math.max(1, Math.round((minGapMs / 1000) * env.frameRate));
  const windowFrames = Math.max(4, Math.round(0.35 * env.frameRate));
  // Calibrated against tests/pipeline.mjs: at the midpoint this has to reject
  // the secondary flux peak a pitched kick throws as it sweeps down, without
  // losing quiet hats. Lower settings keep those extra peaks on purpose.
  const mult = 1.4 + sensitivity * 4;

  // An absolute floor stops near-silent passages from producing onsets purely
  // because the local median there is tiny.
  let peak = 0;
  for (let i = 0; i < n; i++) if (flux[i] > peak) peak = flux[i];
  const floor = peak * (0.015 + sensitivity * 0.16);

  const onsets = [];
  let last = -Infinity;

  for (let i = 1; i < n - 1; i++) {
    const v = flux[i];
    if (v < floor) continue;
    if (v <= flux[i - 1] || v < flux[i + 1]) continue; // local maximum only

    const lo = Math.max(0, i - windowFrames);
    const hi = Math.min(n, i + windowFrames);
    const threshold = median(flux.subarray(lo, hi)) * mult;
    if (v < threshold) continue;

    if (i - last < minGap) {
      // Two detections inside one hit: keep the stronger.
      if (onsets.length && v > flux[onsets[onsets.length - 1]]) {
        onsets[onsets.length - 1] = i;
        last = i;
      }
      continue;
    }

    onsets.push(i);
    last = i;
  }

  return onsets;
}
