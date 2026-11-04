/* Regression test for the analysis pipeline.
 *
 * The pipeline is the product, and it is the one part that cannot be checked
 * by looking at the screen — so it runs against a synthetic take with known
 * hits at a known tempo, defined in fixture.mjs.
 *
 *   node tests/pipeline.mjs            # run the checks
 *   DIAG=1 node tests/pipeline.mjs     # also dump per-hit measurements
 *   SWEEP=1 node tests/pipeline.mjs    # sweep breath strictness for tuning
 */

import { prepare, analyze } from '../src/audio/analyze.js';
import { SR, BPM, SCORE, cleanTake, dirtyTake } from './fixture.mjs';

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'pass' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log(`Synthetic take: ${SCORE.length} hits, ${BPM} BPM, ${(cleanTake.length / SR).toFixed(2)}s\n`);

const prepared = prepare(cleanTake, SR);
const result = analyze(prepared, { sensitivity: 0.5 });

/* --- onsets --------------------------------------------------------------- */

console.log('Onset detection');
// Hats land on the same step as kicks four times; those merge into one onset,
// which is correct, so the expected count is the distinct positions.
const distinctPositions = new Set(SCORE.map(([, step]) => step)).size;
check(
  'finds roughly the right number of hits',
  Math.abs(result.hits.length - distinctPositions) <= 3,
  `found ${result.hits.length}, expected about ${distinctPositions}`
);

/* --- tempo ---------------------------------------------------------------- */

console.log('\nTempo');
const bpm = result.tempo.bpm;
check('recovers the tempo', Math.abs(bpm - BPM) < 3, `got ${bpm} BPM, expected ${BPM}`);
check('is at worst an octave out',
  [bpm, bpm / 2, bpm * 2].some((c) => Math.abs(c - BPM) < 3), `got ${bpm} BPM`);
check('reports usable confidence', result.tempo.confidence > 0.15,
  `confidence ${result.tempo.confidence.toFixed(2)}`);

/* --- classification ------------------------------------------------------- */

console.log('\nClassification');
const names = result.groups.map((g) => g.name);
check('separates the three voices', result.groups.length >= 3 && result.groups.length <= 4,
  `got ${result.groups.length} pads: ${names.join(', ')}`);
check('finds a low sound', names.some((n) => /kick|bass/i.test(n)), names.join(', '));
check('finds a bright sound', names.some((n) => /hat|cymbal/i.test(n)), names.join(', '));
check('finds a noisy mid sound', names.some((n) => /snare|rim|perc|tone/i.test(n)), names.join(', '));

const kickAt = names.findIndex((n) => /kick|bass/i.test(n));
const hatAt = names.findIndex((n) => /hat|cymbal/i.test(n));
check('orders pads dark to bright', kickAt >= 0 && hatAt >= 0 && kickAt < hatAt,
  `kick at ${kickAt}, hat at ${hatAt}`);

/* --- pattern -------------------------------------------------------------- */

console.log('\nPattern');
const filled = result.pattern.steps.flat().filter(Boolean).length;
check('quantises hits onto the grid', filled >= distinctPositions - 4,
  `${filled} steps filled of about ${distinctPositions}`);
check('rounds to whole bars', result.pattern.length % 16 === 0,
  `${result.pattern.length} steps (${result.pattern.bars} bars)`);
check('keeps performed dynamics', new Set(result.pattern.steps.flat()
  .filter(Boolean).map((c) => Math.round(c.velocity * 10))).size > 1,
  'more than one velocity level present');

/* --- breath rejection ------------------------------------------------------ */

console.log('\nBreath rejection');

const dirty = prepare(dirtyTake, SR);
const unfiltered = analyze(dirty, { sensitivity: 0.5, ignoreBreaths: false });
const filtered = analyze(dirty, { sensitivity: 0.5, ignoreBreaths: true });

const realTimes = result.hits.map((h) => h.time);
const isReal = (t) => realTimes.some((rt) => Math.abs(rt - t) < 0.04);

check('breathing adds spurious onsets',
  unfiltered.hits.length > result.hits.length,
  `${unfiltered.hits.length} with breaths vs ${result.hits.length} without`);

// The failure that matters most: a breath must not make the detector deaf.
// A sustained sound inside the adaptive threshold window used to drag the
// local median up and mask the real hits around it.
check('breathing does not mask real hits',
  unfiltered.hits.filter((h) => isReal(h.time)).length >= result.hits.length - 1,
  `${unfiltered.hits.filter((h) => isReal(h.time)).length} of ${result.hits.length} real hits still found`);

const keptReal = filtered.hits.filter((h) => isReal(h.time)).length;
const keptBreath = filtered.hits.length - keptReal;
const totalBreath = unfiltered.hits.length - unfiltered.hits.filter((h) => isReal(h.time)).length;

check('keeps every real hit', keptReal === result.hits.length,
  `${keptReal} of ${result.hits.length}`);
check('rejects most breathing', keptBreath <= Math.max(1, Math.floor(totalBreath * 0.25)),
  `${keptBreath} of ${totalBreath} breath slices survived`);
check('a clean take loses nothing',
  analyze(prepared, { sensitivity: 0.5, ignoreBreaths: true }).rejected.length === 0,
  'nothing rejected from a take with no breaths');

if (process.env.DIAG) {
  console.log('\n  Per-hit measurements (take with breaths)');
  const loudest = Math.max(...unfiltered.hits.map((h) => h.originalPeak));
  for (const h of unfiltered.hits) {
    const f = h.features;
    console.log(`    ${isReal(h.time) ? 'hit   ' : 'BREATH'} t=${h.time.toFixed(2)}s ` +
      `str=${(h.strength ?? 1).toFixed(2)} attack=${Math.round(f.attackMs).toString().padStart(3)}ms ` +
      `crest=${f.crest.toFixed(1).padStart(5)} rel=${(h.originalPeak / loudest).toFixed(2)} ` +
      `flat=${f.flatness.toFixed(2)} dur=${Math.round(f.durationMs)}ms`);
  }
}

if (process.env.SWEEP) {
  console.log('\n  Strictness sweep (real kept / breath kept)');
  for (let s = 0.2; s <= 0.85; s += 0.05) {
    const r = analyze(dirty, { sensitivity: 0.5, ignoreBreaths: true, strictness: s });
    const real = r.hits.filter((h) => isReal(h.time)).length;
    console.log(`    ${s.toFixed(2)}  ${real}/${result.hits.length}  ${r.hits.length - real}`);
  }
}

/* --- sensitivity ----------------------------------------------------------- */

console.log('\nSensitivity');
const eager = analyze(prepared, { sensitivity: 0.05 });
const quiet = analyze(prepared, { sensitivity: 0.95 });
check('sensitivity changes the hit count monotonically',
  eager.hits.length >= result.hits.length && result.hits.length >= quiet.hits.length,
  `${eager.hits.length} / ${result.hits.length} / ${quiet.hits.length} hits at 0.05 / 0.5 / 0.95`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
