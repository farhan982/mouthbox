/* Regression test for the analysis pipeline.
 *
 * The pipeline is the product, and it is the one part that cannot be checked
 * by looking at the screen — so it gets a synthetic take with known hits at a
 * known tempo, and we assert that it comes back out.
 *
 *   node tests/pipeline.mjs
 */

import { prepare, analyze } from '../src/audio/analyze.js';

const SR = 48000;

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'pass' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/* A deterministic noise source, so a failure is reproducible. */
function noise(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 2147483648) - 1;
  };
}

function mix(target, source, atSeconds) {
  const offset = Math.round(atSeconds * SR);
  for (let i = 0; i < source.length; i++) {
    const t = offset + i;
    if (t >= 0 && t < target.length) target[t] += source[i];
  }
}

/* --- synthetic mouth sounds ---------------------------------------------- */

function kick(gain = 1) {
  const n = Math.round(SR * 0.22);
  const out = new Float32Array(n);
  const rnd = noise(7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 26);
    // Pitch sweeps down, like a thrown "b" sound.
    const freq = 110 * Math.exp(-t * 18) + 48;
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * gain;
    if (i < 90) out[i] += rnd() * 0.3 * (1 - i / 90) * gain; // lip transient
  }
  return out;
}

/* A two-pole resonant band pass, so the synthetic snare actually sits in the
 * mids. A one-pole smoother leaves far too much energy above 5 kHz and the
 * result measures as a hi-hat rather than a snare. */
function bandpass(centreHz, q) {
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

function snare(gain = 1) {
  const n = Math.round(SR * 0.19);
  const out = new Float32Array(n);
  const rnd = noise(31);
  const filter = bandpass(1900, 1.1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 30);
    const body = filter(rnd()) * 3.2;
    out[i] = (body * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.45) * env * gain;
  }
  return out;
}

function hat(gain = 1) {
  const n = Math.round(SR * 0.055);
  const out = new Float32Array(n);
  const rnd = noise(97);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 95);
    const white = rnd();
    // One-pole high pass: pushes the energy up where a "ts" lives.
    const high = white - prev;
    prev = white;
    out[i] = high * env * gain;
  }
  return out;
}

/* --- the take ------------------------------------------------------------ */

const BPM = 100;
const STEP = 60 / BPM / 4;          // 16th note
const LEAD_IN = 0.25;

/* Two bars of a plain boom-bap pattern. */
const SCORE = [
  ...[0, 6, 8, 14, 16, 22, 24, 30].map((s) => ['kick', s]),
  ...[4, 12, 20, 28].map((s) => ['snare', s]),
  ...[2, 6, 10, 14, 18, 22, 26, 30].map((s) => ['hat', s]),
];

const totalSteps = 32;
const length = Math.round((LEAD_IN + totalSteps * STEP + 0.5) * SR);
const take = new Float32Array(length);

const voices = { kick, snare, hat };
const expectedTimes = new Set();

for (const [voice, step] of SCORE) {
  const at = LEAD_IN + step * STEP;
  // Slight human drift so the test is not an unrealistically perfect grid.
  const jitter = ((step * 37) % 7 - 3) * 0.0015;
  const gain = voice === 'hat' ? 0.5 : voice === 'snare' ? 0.8 : 1;
  mix(take, voices[voice](gain), at + jitter);
  expectedTimes.add(Math.round((at + jitter) * 1000));
}

// Light room noise, so the adaptive threshold has something to reject.
const rnd = noise(1234);
for (let i = 0; i < take.length; i++) take[i] += rnd() * 0.0015;

// Keep it away from clipping, as a real recording would be.
let peak = 0;
for (const v of take) peak = Math.max(peak, Math.abs(v));
for (let i = 0; i < take.length; i++) take[i] = (take[i] / peak) * 0.8;

/* --- assertions ---------------------------------------------------------- */

console.log(`Synthetic take: ${SCORE.length} hits, ${BPM} BPM, ${(take.length / SR).toFixed(2)}s\n`);

const prepared = prepare(take, SR);
const result = analyze(prepared, { sensitivity: 0.5 });

console.log('Onset detection');
// Hats land on the same step as kicks four times; those merge into one onset,
// which is correct behaviour, so the expected count is the distinct positions.
const expected = expectedTimes.size;
check(
  'finds roughly the right number of hits',
  Math.abs(result.hits.length - expected) <= 3,
  `found ${result.hits.length}, expected about ${expected}`
);

console.log('\nTempo');
const bpm = result.tempo.bpm;
const octaveOk = [bpm, bpm / 2, bpm * 2].some((candidate) => Math.abs(candidate - BPM) < 3);
check('recovers the tempo', Math.abs(bpm - BPM) < 3, `got ${bpm} BPM, expected ${BPM}`);
check('is at worst an octave out', octaveOk, `got ${bpm} BPM`);
check('reports usable confidence', result.tempo.confidence > 0.15,
  `confidence ${result.tempo.confidence.toFixed(2)}`);

console.log('\nClassification');
const names = result.groups.map((g) => g.name);
check('separates the three voices', result.groups.length >= 3 && result.groups.length <= 4,
  `got ${result.groups.length} pads: ${names.join(', ')}`);
check('finds a low sound', names.some((n) => /kick|bass/i.test(n)), names.join(', '));
check('finds a bright sound', names.some((n) => /hat|cymbal/i.test(n)), names.join(', '));
check('finds a noisy mid sound', names.some((n) => /snare|rim|perc|tone/i.test(n)), names.join(', '));

// Pads are sorted dark to bright, so the kick must come before the hat.
const kickAt = names.findIndex((n) => /kick|bass/i.test(n));
const hatAt = names.findIndex((n) => /hat|cymbal/i.test(n));
check('orders pads dark to bright', kickAt >= 0 && hatAt >= 0 && kickAt < hatAt,
  `kick at ${kickAt}, hat at ${hatAt}`);

console.log('\nPattern');
const filled = result.pattern.steps.flat().filter(Boolean).length;
check('quantises hits onto the grid', filled >= expected - 4,
  `${filled} steps filled of about ${expected}`);
check('rounds to whole bars', result.pattern.length % 16 === 0,
  `${result.pattern.length} steps (${result.pattern.bars} bars)`);
check('keeps performed dynamics', new Set(result.pattern.steps.flat()
  .filter(Boolean).map((c) => Math.round(c.velocity * 10))).size > 1,
  'more than one velocity level present');

if (process.env.DIAG) {
  console.log('\nFeature dump');
  for (const g of result.groups) {
    const f = g.mean;
    console.log(`  ${g.name.padEnd(8)} n=${String(g.members.length).padStart(2)} ` +
      `centroid=${Math.round(f.centroid).toString().padStart(5)} ` +
      `rolloff=${Math.round(f.rolloff).toString().padStart(5)} ` +
      `low=${f.lowRatio.toFixed(2)} high=${f.highRatio.toFixed(2)} ` +
      `flat=${f.flatness.toFixed(3)} zcr=${f.zcr.toFixed(2)} decay=${Math.round(f.decayMs)}ms`);
  }
}

console.log('\nSensitivity');
const quiet = analyze(prepared, { sensitivity: 0.95 });
const eager = analyze(prepared, { sensitivity: 0.05 });
check('sensitivity changes the hit count monotonically',
  eager.hits.length >= result.hits.length && result.hits.length >= quiet.hits.length,
  `${eager.hits.length} / ${result.hits.length} / ${quiet.hits.length} hits at 0.05 / 0.5 / 0.95`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
