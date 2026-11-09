/* Finding the structure in a performance.
 *
 * A song-length take comes out of the analyser as one enormous grid. That is
 * unusable — you cannot edit two hundred bars on a step sequencer, and it
 * throws away the fact that you played the same eight bars four times.
 *
 * This cuts the grid into blocks, works out which blocks are the same thing
 * played again, and returns a handful of sections plus the order they occur
 * in. The app already understands patterns and a chain, so an arrangement is
 * expressed in those terms rather than in a new concept.
 *
 * Pure: grid in, sections out. No DOM, no audio.
 */

const STEPS_PER_BAR = 16;

/* Candidate section lengths, in bars, in preference order.
 *
 * These are tried in turn and the first that explains the song is taken,
 * rather than the one that scores highest. Scoring highest is the wrong
 * target: the repeat ratio always rises as sections get shorter, because
 * shorter sections mean more blocks to find repeats among, so a pure maximum
 * collapses every song to the smallest candidate. A groove that loops every
 * bar is not a one-bar song.
 *
 * 8 leads because it is the commonest phrase length in the music this app is
 * for, and because 8 bars is an editable unit on a step grid.
 */
const CANDIDATE_BARS = [8, 4, 16, 2];

/* The repeat ratio a section length has to reach to be accepted. Low on
 * purpose: this is asking "does this length explain anything?", and the
 * preference order decides the rest. */
const EXPLAINS_SONG = 0.25;

/* How alike two blocks have to be to count as the same section. Below this
 * and a variation becomes its own section; above it and genuinely different
 * parts get merged. */
const SAME_SECTION = 0.78;

function blockOf(steps, start, length) {
  return steps.map((lane) => {
    const out = new Array(length).fill(null);
    for (let i = 0; i < length; i++) out[i] = lane[start + i] || null;
    return out;
  });
}

/* Agreement between two blocks, over the steps where either has a hit.
 *
 * Counting matching silence would score two sparse blocks as near-identical
 * simply for being empty in the same places, so only union positions count.
 */
export function similarity(a, b) {
  let match = 0;
  let union = 0;

  for (let lane = 0; lane < a.length; lane++) {
    const left = a[lane];
    const right = b[lane] || [];
    for (let step = 0; step < left.length; step++) {
      const x = !!left[step];
      const y = !!right[step];
      if (x || y) {
        union++;
        if (x && y) match++;
      }
    }
  }

  return union === 0 ? 1 : match / union;
}

function density(block) {
  let hits = 0;
  for (const lane of block) for (const cell of lane) if (cell) hits++;
  return hits;
}

/* The consensus of several takes of the same section.
 *
 * A step is kept when most of the repeats have it, and its velocity is the
 * average of the ones that do. This is where playing a part four times
 * actually pays off: a hit you fluffed once gets voted out, and a hit you
 * meant every time survives at its typical weight.
 */
function consolidate(blocks) {
  const lanes = blocks[0].length;
  const length = blocks[0][0].length;
  const threshold = blocks.length / 2;

  const out = [];
  for (let lane = 0; lane < lanes; lane++) {
    const row = new Array(length).fill(null);
    for (let step = 0; step < length; step++) {
      const present = blocks
        .map((block) => block[lane]?.[step])
        .filter(Boolean);
      if (present.length > threshold) {
        const velocity = present.reduce((s, c) => s + c.velocity, 0) / present.length;
        row[step] = { velocity, sampleId: present[0].sampleId || null };
      }
    }
    out.push(row);
  }
  return out;
}

/* Groups blocks into sections. Greedy against each section's running
 * representative, which is enough when sections are long and distinct. */
function groupBlocks(blocks, threshold) {
  const sections = [];

  for (const block of blocks) {
    let placed = false;
    for (const section of sections) {
      if (similarity(block, section.blocks[0]) >= threshold) {
        section.blocks.push(block);
        placed = true;
        break;
      }
    }
    if (!placed) sections.push({ blocks: [block], order: sections.length });
  }

  return sections;
}

/* How well a given section length explains the song: the share of blocks
 * that turned out to be repeats of something already seen. */
function compression(steps, totalSteps, bars, threshold) {
  const length = bars * STEPS_PER_BAR;
  const count = Math.ceil(totalSteps / length);
  if (count < 2) return { score: -1 };

  const blocks = [];
  for (let i = 0; i < count; i++) blocks.push(blockOf(steps, i * length, length));

  const sections = groupBlocks(blocks, threshold);
  // Blocks saved by repetition, as a fraction. A song of four identical
  // 8-bar blocks scores 0.75; four different ones score 0.
  const score = (blocks.length - sections.length) / blocks.length;

  return { score, blocks, sections, length, count };
}

/* Labels a section by how busy it is relative to the rest.
 *
 * This is a hint, not an understanding — the app cannot know what you meant.
 * A sparse section may be a breakdown or may be where you lost your place.
 * It is surfaced as a suggestion the user can overrule, never acted on.
 */
function roleFor(hits, maxHits, index, total) {
  if (maxHits === 0) return 'empty';
  const share = hits / maxHits;
  if (share < 0.35) return 'break';
  if (index === 0 && share < 0.7) return 'intro';
  // Calling the busiest section a drop only says anything when there are
  // several to compare it against; with two sections it is just "the other
  // one", which is not worth labelling.
  if (share >= 0.98 && total > 2) return 'drop';
  return 'main';
}

function nameFor(index) {
  return index < 26
    ? String.fromCharCode(65 + index)
    : `S${index + 1}`;
}

/* Cuts a long pattern into sections and the order they play in.
 *
 * Returns patterns ready for the kit, and a chain of { patternId, repeats }.
 * Consecutive repeats of a section collapse into one chain entry.
 */
export function arrange(pattern, {
  threshold = SAME_SECTION,
  sectionBars = 'auto',
  consolidateRepeats = true,
  makeId = (i) => `sec${i + 1}`,
} = {}) {
  const totalSteps = pattern.length;
  const steps = pattern.steps;

  if (!steps.length || totalSteps <= STEPS_PER_BAR * 2) {
    // Too short to have structure; leave it as the single section it is.
    return {
      patterns: [{ ...pattern, id: makeId(0), name: 'A', role: 'main' }],
      chain: [{ patternId: makeId(0), repeats: 1 }],
      sectionBars: Math.max(1, Math.round(totalSteps / STEPS_PER_BAR)),
      blocks: 1,
    };
  }

  let best = null;
  let fallback = null;
  const candidates = sectionBars === 'auto' ? CANDIDATE_BARS : [sectionBars];

  for (const bars of candidates) {
    if (bars * STEPS_PER_BAR > totalSteps) continue;
    const attempt = compression(steps, totalSteps, bars, threshold);
    if (attempt.score < 0) continue;

    // Keep the strongest as a fallback for a song with no repetition at all.
    if (!fallback || attempt.score > fallback.score + 1e-9) fallback = { ...attempt, bars };

    // First length that explains the song wins, in preference order.
    if (attempt.score >= EXPLAINS_SONG) { best = { ...attempt, bars }; break; }
  }

  if (!best) best = fallback;

  if (!best) {
    return {
      patterns: [{ ...pattern, id: makeId(0), name: 'A', role: 'main' }],
      chain: [{ patternId: makeId(0), repeats: 1 }],
      sectionBars: Math.round(totalSteps / STEPS_PER_BAR),
      blocks: 1,
    };
  }

  const { blocks, sections, length, bars } = best;

  const counts = sections.map((s) => density(consolidateRepeats
    ? consolidate(s.blocks)
    : s.blocks[0]));
  const maxHits = Math.max(...counts, 0);

  const patterns = sections.map((section, index) => {
    const body = consolidateRepeats ? consolidate(section.blocks) : section.blocks[0];
    return {
      id: makeId(index),
      name: nameFor(index),
      length,
      bars,
      stepsPerBeat: pattern.stepsPerBeat || 4,
      steps: body,
      role: roleFor(counts[index], maxHits, index, sections.length),
      takes: section.blocks.length,
    };
  });

  // Walk the song in order, mapping each block back to its section.
  const order = [];
  for (const block of blocks) {
    const index = sections.findIndex((s) => s.blocks.includes(block));
    order.push(index < 0 ? 0 : index);
  }

  const chain = [];
  for (const index of order) {
    const last = chain[chain.length - 1];
    if (last && last.patternId === patterns[index].id) last.repeats++;
    else chain.push({ patternId: patterns[index].id, repeats: 1 });
  }

  return { patterns, chain, sectionBars: bars, blocks: blocks.length };
}

export { STEPS_PER_BAR, SAME_SECTION };
