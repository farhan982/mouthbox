/* The synthetic take the tests and tuning scripts share.
 *
 * Kept separate so a tuning sweep can import the exact audio the test suite
 * asserts against, rather than a near-copy that drifts out of step with it.
 */

export const SR = 48000;

export function noise(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 2147483648) - 1;
  };
}

export function bandpass(centreHz, q) {
  const w = (2 * Math.PI * centreHz) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const norm = 1 + alpha;
  const b0 = alpha / norm;
  const b2 = -alpha / norm;
  const a1 = (-2 * Math.cos(w)) / norm;
  const a2 = (1 - alpha) / norm;
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  return (x) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

export function kick(gain = 1) {
  const n = Math.round(SR * 0.22);
  const out = new Float32Array(n);
  const rnd = noise(7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 26);
    const freq = 110 * Math.exp(-t * 18) + 48;
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * gain;
    if (i < 90) out[i] += rnd() * 0.3 * (1 - i / 90) * gain;
  }
  return out;
}

export function snare(gain = 1) {
  const n = Math.round(SR * 0.19);
  const out = new Float32Array(n);
  const rnd = noise(31);
  const filter = bandpass(1900, 1.1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 30);
    out[i] = (filter(rnd()) * 3.2 * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.45) * env * gain;
  }
  return out;
}

export function hat(gain = 1) {
  const n = Math.round(SR * 0.055);
  const out = new Float32Array(n);
  const rnd = noise(97);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 95);
    const white = rnd();
    const high = white - prev;
    prev = white;
    out[i] = high * env * gain;
  }
  return out;
}

export function breath(gain = 1) {
  const n = Math.round(SR * 0.42);
  const out = new Float32Array(n);
  const rnd = noise(613);
  const filter = bandpass(1400, 0.5);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.09) * Math.exp(-Math.max(0, t - 0.09) * 5.5);
    prev = prev * 0.6 + rnd() * 0.4;
    out[i] = (filter(prev) * 2.4 + prev * 0.4) * env * gain;
  }
  return out;
}

export const BPM = 100;
export const STEP = 60 / BPM / 4;
export const LEAD_IN = 0.25;

export const SCORE = [
  ...[0, 6, 8, 14, 16, 22, 24, 30].map((s) => ['kick', s]),
  ...[4, 12, 20, 28].map((s) => ['snare', s]),
  ...[2, 6, 10, 14, 18, 22, 26, 30].map((s) => ['hat', s]),
];

export function mix(target, source, atSeconds) {
  const offset = Math.round(atSeconds * SR);
  for (let i = 0; i < source.length; i++) {
    const t = offset + i;
    if (t >= 0 && t < target.length) target[t] += source[i];
  }
}

function build({ withBreaths }) {
  const voices = { kick, snare, hat };
  const take = new Float32Array(Math.round((LEAD_IN + 32 * STEP + 0.5) * SR));

  for (const [voice, step] of SCORE) {
    const jitter = ((step * 37) % 7 - 3) * 0.0015;
    const gain = voice === 'hat' ? 0.5 : voice === 'snare' ? 0.8 : 1;
    mix(take, voices[voice](gain), LEAD_IN + step * STEP + jitter);
  }

  if (withBreaths) {
    for (const step of [3, 11, 19, 27]) {
      mix(take, breath(0.16), LEAD_IN + step * STEP + STEP * 0.45);
    }
  }

  const rnd = noise(1234);
  for (let i = 0; i < take.length; i++) take[i] += rnd() * 0.0015;

  let peak = 0;
  for (const v of take) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < take.length; i++) take[i] = (take[i] / peak) * 0.8;

  return take;
}

export const cleanTake = build({ withBreaths: false });
export const dirtyTake = build({ withBreaths: true });
