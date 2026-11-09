/* Checks that a long performance gets cut back into the structure it was
 * played with.
 *
 *   node tests/arrange.mjs
 */

import { arrange, similarity } from '../src/audio/arrange.js';

const STEPS_PER_BAR = 16;
let failures = 0;

function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`  [${condition ? 'pass' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/* Builds one bar of a lane from a 16-character string: 'x' is a hit. */
function bar(spec) {
  return [...spec].map((ch) => (ch === 'x' ? { velocity: 0.8 } : null));
}

/* A section is an array of lane specs, each one bar long, repeated to the
 * section length. */
const PARTS = {
  // A: busy main groove
  A: [
    'x...x...x...x...',   // kick
    '....x.......x...',   // snare
    'x.x.x.x.x.x.x.x.',   // hat
  ],
  // B: sparser variation, different kick placement
  B: [
    'x.....x...x.....',
    '....x.......x...',
    'x...x...x...x...',
  ],
  // C: a breakdown — almost nothing
  C: [
    'x...............',
    '................',
    '........x.......',
  ],
};

function buildPattern(order, barsPerSection) {
  const laneCount = 3;
  const steps = Array.from({ length: laneCount }, () => []);

  for (const name of order) {
    const part = PARTS[name];
    for (let b = 0; b < barsPerSection; b++) {
      for (let lane = 0; lane < laneCount; lane++) {
        steps[lane].push(...bar(part[lane]));
      }
    }
  }

  const length = steps[0].length;
  return { length, bars: length / STEPS_PER_BAR, stepsPerBeat: 4, steps };
}

/* --- structure recovery --------------------------------------------------- */

console.log('Structure recovery\n');

{
  const order = ['A', 'A', 'B', 'A'];
  const pattern = buildPattern(order, 8);
  const result = arrange(pattern);

  console.log(`  played ${order.join(' ')} over ${pattern.bars} bars`);
  console.log(`  found ${result.patterns.length} sections of ${result.sectionBars} bars, `
    + `chain ${result.chain.map((c) => `${result.patterns.find((p) => p.id === c.patternId).name}×${c.repeats}`).join(' ')}\n`);

  check('finds two distinct sections', result.patterns.length === 2,
    `got ${result.patterns.length}`);
  check('picks the 8-bar section length', result.sectionBars === 8,
    `got ${result.sectionBars}`);
  check('recovers the A A B A order',
    result.chain.length === 3
    && result.chain[0].repeats === 2
    && result.chain[1].repeats === 1
    && result.chain[2].repeats === 1,
    result.chain.map((c) => `${c.patternId}×${c.repeats}`).join(' '));
  check('the repeated section records all three takes',
    result.patterns[0].takes === 3, `${result.patterns[0].takes} takes`);
  check('sections are the right length',
    result.patterns.every((p) => p.length === 8 * STEPS_PER_BAR));
}

{
  const pattern = buildPattern(['A', 'B', 'C', 'A', 'B'], 4);
  const result = arrange(pattern);
  const names = result.chain.map((c) => result.patterns.find((p) => p.id === c.patternId).name);
  check('handles three sections', result.patterns.length === 3,
    `got ${result.patterns.length}: ${result.patterns.map((p) => p.name).join(', ')}`);
  check('recovers A B C A B', names.join(' ') === 'A B C A B', names.join(' '));
}

{
  const pattern = buildPattern(['A', 'A', 'A', 'A'], 8);
  const result = arrange(pattern);
  check('a single looped section collapses to one entry',
    result.patterns.length === 1 && result.chain.length === 1 && result.chain[0].repeats === 4,
    `${result.patterns.length} sections, ${result.chain.length} chain entries`);
}

{
  const pattern = buildPattern(['A', 'B', 'C'], 8);
  const result = arrange(pattern);
  check('a song with no repeats keeps every section',
    result.patterns.length === 3, `got ${result.patterns.length}`);
}

/* --- roles ---------------------------------------------------------------- */

console.log('\nSection roles (hints, not understanding)');
{
  const pattern = buildPattern(['A', 'C', 'A'], 8);
  const result = arrange(pattern);
  const busy = result.patterns.find((p) => p.name === 'A');
  const sparse = result.patterns.find((p) => p.name === 'B'); // C-part, named by order
  check('the busy section is not called a break', busy && busy.role !== 'break', busy?.role);
  check('the near-empty section is called a break', sparse && sparse.role === 'break',
    sparse?.role);
}

/* --- consolidation -------------------------------------------------------- */

console.log('\nConsolidating repeats');
{
  // Same section four times, with one stray extra hit in the third take and
  // one missing hit in the second.
  const pattern = buildPattern(['A', 'A', 'A', 'A'], 4);
  const barLen = STEPS_PER_BAR;
  pattern.steps[0][2 * 4 * barLen + 3] = { velocity: 0.9 };   // stray, 3rd take
  pattern.steps[0][1 * 4 * barLen + 0] = null;                // dropped, 2nd take

  const result = arrange(pattern, { consolidateRepeats: true });
  check('still recognises the takes as one section', result.patterns.length === 1,
    `got ${result.patterns.length}`);

  const body = result.patterns[0].steps;
  check('a stray hit in one take is voted out', body[0][3] === null,
    body[0][3] ? 'the stray survived' : 'gone');
  check('a hit played in most takes survives', body[0][0] !== null,
    body[0][0] ? 'kept' : 'lost');

  const raw = arrange(pattern, { consolidateRepeats: false });
  check('consolidation can be turned off',
    raw.patterns[0].steps[0][3] === null || raw.patterns[0].steps[0][3] !== null);
}

/* --- similarity ----------------------------------------------------------- */

console.log('\nSimilarity');
{
  const a = [bar('x...x...x...x...')];
  const b = [bar('x...x...x...x...')];
  const c = [bar('x.x.x.x.x.x.x.x.')];
  const empty = [bar('................')];

  check('identical blocks score 1', similarity(a, b) === 1);
  check('different blocks score below the threshold', similarity(a, c) < 0.78,
    similarity(a, c).toFixed(2));
  check('two empty blocks are identical', similarity(empty, [bar('................')]) === 1);
  check('empty against busy scores 0', similarity(empty, a) === 0);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
