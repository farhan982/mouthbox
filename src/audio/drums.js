/* Synthesised drum voices.
 *
 * These are generated rather than sampled. A sample pack would mean licensed
 * audio, megabytes of download in an app that currently ships no assets at
 * all, and a fixed set of sounds. Synthesis costs a few KB, every parameter
 * stays open, and each voice can be tuned to the mouth sound it is layered
 * under rather than being a generic kick bolted on top.
 *
 * The aesthetic is a drum machine, not an acoustic kit — which suits a
 * beatbox app, since beatboxing is largely an imitation of one.
 *
 * Everything here is pure: given a sample rate and parameters it returns a
 * Float32Array. That keeps it testable without an AudioContext.
 */

/* --- building blocks ------------------------------------------------------ */

/* Deterministic noise. A fixed seed means a given kit always renders the
 * same way, so an export matches what was previewed. */
function noise(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2147483648) - 1;
  };
}

function biquad(kind, freq, q, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);

  let b0; let b1; let b2; let a0; let a1; let a2;
  if (kind === 'lowpass') {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (kind === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else { // bandpass
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  }

  const n0 = b0 / a0; const n1 = b1 / a0; const n2 = b2 / a0;
  const d1 = a1 / a0; const d2 = a2 / a0;
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;

  return (x) => {
    const y = n0 * x + n1 * x1 + n2 * x2 - d1 * y1 - d2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/* Exponential decay that reaches near-silence at `seconds`. */
function decayEnv(t, seconds) {
  return Math.exp((-5 * t) / Math.max(0.005, seconds));
}

function finish(out, sampleRate) {
  // Short fades: a drum that starts or ends on a non-zero sample clicks.
  const fadeIn = Math.min(out.length, Math.round(sampleRate * 0.0008));
  const fadeOut = Math.min(out.length, Math.round(sampleRate * 0.004));
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i] *= i / fadeOut;

  let peak = 0;
  for (const v of out) { const a = Math.abs(v); if (a > peak) peak = a; }
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.89;
  return out;
}

/* --- voices --------------------------------------------------------------- */

function kick({ tune = 52, decay = 0.38, punch = 1, click = 0.22 }, sampleRate) {
  const n = Math.round(sampleRate * (decay + 0.05));
  const out = new Float32Array(n);
  const rnd = noise(11);
  // Starts about two octaves up and falls to the tuned pitch.
  const start = tune * (3.2 * punch + 1);

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const freq = tune + (start - tune) * Math.exp(-t * 38 * punch);
    phase += (2 * Math.PI * freq) / sampleRate;
    const env = decayEnv(t, decay);
    out[i] = Math.sin(phase) * env;
    if (t < 0.006) out[i] += rnd() * click * (1 - t / 0.006);
  }
  return finish(out, sampleRate);
}

function snare({ tune = 190, decay = 0.19, snap = 0.72 }, sampleRate) {
  const n = Math.round(sampleRate * (decay + 0.05));
  const out = new Float32Array(n);
  const rnd = noise(29);
  const band = biquad('bandpass', 1750, 0.8, sampleRate);
  const shell = biquad('highpass', 180, 0.7, sampleRate);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // Two detuned shell tones under a noise burst.
    const body = (Math.sin(2 * Math.PI * tune * t) + Math.sin(2 * Math.PI * tune * 1.58 * t) * 0.6)
      * decayEnv(t, decay * 0.5);
    const rattle = band(rnd()) * 2.6 * decayEnv(t, decay);
    out[i] = shell(rattle * snap + body * (1 - snap) * 0.9);
  }
  return finish(out, sampleRate);
}

function clap({ decay = 0.24, spread = 1 }, sampleRate) {
  const n = Math.round(sampleRate * (decay + 0.06));
  const out = new Float32Array(n);
  const rnd = noise(53);
  const band = biquad('bandpass', 1350, 0.6, sampleRate);

  // Three fast slaps then a tail: what makes a clap read as a clap rather
  // than as a short snare.
  const slaps = [0, 0.011 * spread, 0.023 * spread];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let env = 0;
    for (const at of slaps) {
      if (t >= at) env = Math.max(env, Math.exp(-(t - at) * 420));
    }
    const tail = t > slaps[2] ? decayEnv(t - slaps[2], decay) * 0.55 : 0;
    out[i] = band(rnd()) * 2.8 * Math.max(env, tail);
  }
  return finish(out, sampleRate);
}

function hat({ decay = 0.055, tone = 1 }, sampleRate) {
  const n = Math.round(sampleRate * (decay + 0.03));
  const out = new Float32Array(n);
  const rnd = noise(71);
  const hp = biquad('highpass', 7200 * tone, 0.8, sampleRate);
  // A touch of metallic ring over the noise, the way an 808 stacks squares.
  const ring = [2371, 3112, 4337];

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let metal = 0;
    for (const f of ring) metal += Math.sign(Math.sin(2 * Math.PI * f * tone * t));
    out[i] = hp(rnd() * 1.4 + metal * 0.12) * decayEnv(t, decay);
  }
  return finish(out, sampleRate);
}

function rim({ tune = 1700, decay = 0.035 }, sampleRate) {
  const n = Math.round(sampleRate * (decay + 0.02));
  const out = new Float32Array(n);
  const rnd = noise(97);
  const band = biquad('bandpass', tune, 2.4, sampleRate);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = band(rnd() + Math.sin(2 * Math.PI * tune * t) * 0.8) * decayEnv(t, decay);
  }
  return finish(out, sampleRate);
}

function tom({ tune = 180, decay = 0.3 }, sampleRate) {
  const n = Math.round(sampleRate * (decay + 0.05));
  const out = new Float32Array(n);
  const rnd = noise(131);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const freq = tune * (1 + 0.6 * Math.exp(-t * 22));
    phase += (2 * Math.PI * freq) / sampleRate;
    const env = decayEnv(t, decay);
    out[i] = Math.sin(phase) * env + (t < 0.004 ? rnd() * 0.25 * (1 - t / 0.004) : 0);
  }
  return finish(out, sampleRate);
}

function cymbal({ decay = 0.9, tone = 1 }, sampleRate) {
  const n = Math.round(sampleRate * (decay + 0.05));
  const out = new Float32Array(n);
  const rnd = noise(167);
  const hp = biquad('highpass', 5200 * tone, 0.6, sampleRate);
  const ring = [1853, 2471, 3119, 4021, 5113];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let metal = 0;
    for (const f of ring) metal += Math.sign(Math.sin(2 * Math.PI * f * tone * t));
    out[i] = hp(rnd() * 1.2 + metal * 0.16) * decayEnv(t, decay);
  }
  return finish(out, sampleRate);
}

const VOICES = { kick, snare, clap, hat, openhat: hat, rim, tom, cymbal };

export const DRUM_TYPES = [
  { id: 'none', label: 'No layer' },
  { id: 'kick', label: 'Kick' },
  { id: 'snare', label: 'Snare' },
  { id: 'clap', label: 'Clap' },
  { id: 'hat', label: 'Closed hat' },
  { id: 'openhat', label: 'Open hat' },
  { id: 'rim', label: 'Rim' },
  { id: 'tom', label: 'Tom' },
  { id: 'cymbal', label: 'Cymbal' },
];

/* What each voice exposes, so the inspector can build its controls without
 * knowing anything about the synthesis. */
const SECONDS = (v) => `${Math.round(v * 1000)} ms`;
const HZ = (v) => `${Math.round(v)} Hz`;
const AMOUNT = (v) => `${Math.round(v * 100)}%`;

export const DRUM_PARAMS = {
  kick: [
    { key: 'tune', label: 'Tune', min: 30, max: 90, step: 1, fallback: 52, format: HZ },
    { key: 'decay', label: 'Decay', min: 0.08, max: 0.8, step: 0.01, fallback: 0.38, format: SECONDS },
    { key: 'punch', label: 'Punch', min: 0.2, max: 1.6, step: 0.05, fallback: 1, format: AMOUNT },
  ],
  snare: [
    { key: 'tune', label: 'Tune', min: 120, max: 320, step: 2, fallback: 190, format: HZ },
    { key: 'decay', label: 'Decay', min: 0.05, max: 0.5, step: 0.01, fallback: 0.19, format: SECONDS },
    { key: 'snap', label: 'Snap', min: 0, max: 1, step: 0.02, fallback: 0.72, format: AMOUNT },
  ],
  clap: [
    { key: 'decay', label: 'Decay', min: 0.08, max: 0.5, step: 0.01, fallback: 0.24, format: SECONDS },
    { key: 'spread', label: 'Spread', min: 0.4, max: 2, step: 0.05, fallback: 1, format: AMOUNT },
  ],
  hat: [
    { key: 'decay', label: 'Decay', min: 0.02, max: 0.2, step: 0.005, fallback: 0.055, format: SECONDS },
    { key: 'tone', label: 'Tone', min: 0.6, max: 1.6, step: 0.02, fallback: 1, format: AMOUNT },
  ],
  openhat: [
    { key: 'decay', label: 'Decay', min: 0.1, max: 0.8, step: 0.01, fallback: 0.34, format: SECONDS },
    { key: 'tone', label: 'Tone', min: 0.6, max: 1.6, step: 0.02, fallback: 1, format: AMOUNT },
  ],
  rim: [
    { key: 'tune', label: 'Tune', min: 800, max: 3000, step: 20, fallback: 1700, format: HZ },
    { key: 'decay', label: 'Decay', min: 0.01, max: 0.12, step: 0.005, fallback: 0.035, format: SECONDS },
  ],
  tom: [
    { key: 'tune', label: 'Tune', min: 60, max: 350, step: 2, fallback: 180, format: HZ },
    { key: 'decay', label: 'Decay', min: 0.08, max: 0.8, step: 0.01, fallback: 0.3, format: SECONDS },
  ],
  cymbal: [
    { key: 'decay', label: 'Decay', min: 0.2, max: 2, step: 0.02, fallback: 0.9, format: SECONDS },
    { key: 'tone', label: 'Tone', min: 0.6, max: 1.6, step: 0.02, fallback: 1, format: AMOUNT },
  ],
};

/* Renders one voice. Results are cached: a pad retriggers constantly and the
 * synthesis is identical every time for the same parameters. */
const cache = new Map();

export function renderDrum(type, params = {}, sampleRate = 48000) {
  if (!type || type === 'none') return null;
  const voice = VOICES[type];
  if (!voice) return null;

  const key = `${type}|${sampleRate}|${JSON.stringify(params)}`;
  let buffer = cache.get(key);
  if (!buffer) {
    const defaults = type === 'openhat' ? { decay: 0.34 } : {};
    buffer = voice({ ...defaults, ...params }, sampleRate);
    cache.set(key, buffer);
  }
  return buffer;
}

/* Picks a voice and tuning for a pad from what the pad actually sounds like.
 *
 * The name carries the classifier's verdict, and the measured timbre tunes
 * the voice to sit under that specific sound rather than beside it — a deep
 * mouth kick gets a deep synth kick.
 */
export function suggestDrum(padName, tone = {}) {
  const name = String(padName || '').toLowerCase();
  const centroid = tone.centroid || 0;
  const decayMs = tone.decayMs || 120;

  const clampTune = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  if (/bass/.test(name)) {
    return { type: 'kick', tune: clampTune(centroid * 0.25, 35, 60), decay: 0.6, punch: 0.6 };
  }
  if (/kick/.test(name)) {
    return {
      type: 'kick',
      // The mouth kick's own brightness maps onto the synth kick's pitch.
      tune: clampTune(38 + centroid / 90, 38, 70),
      decay: clampTune(decayMs / 1000 + 0.18, 0.18, 0.6),
      punch: 1,
    };
  }
  if (/open ?hat/.test(name)) return { type: 'openhat', decay: clampTune(decayMs / 1000 + 0.2, 0.2, 0.6) };
  if (/hat/.test(name)) return { type: 'hat', decay: clampTune(decayMs / 1000, 0.03, 0.12) };
  if (/cymbal/.test(name)) return { type: 'cymbal', decay: 0.9 };
  if (/clap/.test(name)) return { type: 'clap', decay: 0.24 };
  if (/rim/.test(name)) return { type: 'rim', tune: clampTune(centroid, 900, 2600), decay: 0.035 };
  if (/snare/.test(name)) {
    return {
      type: 'snare',
      tune: clampTune(centroid / 10, 140, 260),
      decay: clampTune(decayMs / 1000 + 0.06, 0.08, 0.35),
      snap: 0.72,
    };
  }
  if (/tone/.test(name)) return { type: 'tom', tune: clampTune(centroid / 8, 80, 300), decay: 0.3 };

  // Anything unrecognised: pick on brightness alone.
  if (centroid < 900) return { type: 'kick', tune: 50, decay: 0.35, punch: 1 };
  if (centroid > 6000) return { type: 'hat', decay: 0.06 };
  return { type: 'tom', tune: clampTune(centroid / 8, 80, 300), decay: 0.25 };
}

/* Equal-power crossfade between the recorded sound and its drum layer.
 * A linear fade dips in the middle; this holds the level steady. */
export function blendGains(blend) {
  const b = Math.max(0, Math.min(1, blend));
  return { sample: Math.cos((b * Math.PI) / 2), drum: Math.sin((b * Math.PI) / 2) };
}
