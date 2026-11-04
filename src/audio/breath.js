/* Telling hits from breathing.
 *
 * Over a song-length take this matters more than anything else in the
 * pipeline. A four-minute performance is mostly you breathing, and every
 * inhale that survives into the kit becomes a pad nobody wants and a step on
 * the grid that should not be there.
 *
 * Nothing here is about loudness alone — a ghost note is quiet too. What
 * separates a breath from a hit is shape: a hit is there instantly and is
 * spiky, a breath swells and is flat.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* How much of a wash this hit is sitting in.
 *
 * One breath produces a run of onsets, not one: the detector trips several
 * times on the same continuous noise. The leading slice of that run looks
 * hit-like on its own — it is the loudest part of the swell — so the only
 * thing that gives it away is the train of very weak onsets right behind it.
 */
function washContext(hits) {
  const WINDOW = 0.45;
  const WEAK = 0.26;

  return hits.map((hit, i) => {
    let weak = 0;
    let total = 0;
    for (let j = Math.max(0, i - 4); j < Math.min(hits.length, i + 5); j++) {
      if (j === i) continue;
      if (Math.abs(hits[j].time - hit.time) > WINDOW) continue;
      total++;
      if ((hits[j].strength ?? 1) < WEAK) weak++;
    }
    return total >= 2 ? weak / total : 0;
  });
}

/* Each indicator returns 0 (definitely a hit) to 1 (definitely a breath). */
function indicators(hit, loudest, wash = 0) {
  const f = hit.features;
  const relative = loudest > 0 ? hit.originalPeak / loudest : 1;

  return {
    // The strongest signal by a distance. A struck sound produces a large
    // jump in the detection function; a wash of breath produces a ripple.
    // Per-slice timbre alone cannot do this — a kick and an inhale can share
    // a crest factor — but their onset strengths are far apart.
    weakOnset: clamp01((0.5 - (hit.strength ?? 1)) / 0.32),

    // Surrounded by weak onsets: part of a sustained wash, not a strike.
    inWash: wash,

    // A percussive attack is under ~8 ms. Breaths take tens of ms to swell.
    slowAttack: clamp01((f.attackMs - 8) / 26),

    // Peak over RMS. Spiky sounds score 6–20; breath noise sits near 3.
    lowCrest: clamp01((6.5 - f.crest) / 4),

    // Quiet relative to the performance, which breaths almost always are.
    quiet: clamp01((0.2 - relative) / 0.17),

    // Breath noise is broadband and unstructured.
    flat: clamp01((f.flatness - 0.3) / 0.35),

    // Long and soft together: a sustained wash rather than a strike.
    sustained: clamp01((f.durationMs - 180) / 400) * clamp01((5.5 - f.crest) / 3),
  };
}

const WEIGHTS = {
  weakOnset: 2.4,
  inWash: 1.8,
  slowAttack: 1.2,
  lowCrest: 1.3,
  quiet: 0.9,
  flat: 0.5,
  sustained: 0.8,
};

export function breathScore(hit, loudest, wash = 0) {
  const values = indicators(hit, loudest, wash);
  let total = 0;
  let weight = 0;
  for (const [key, value] of Object.entries(values)) {
    total += value * WEIGHTS[key];
    weight += WEIGHTS[key];
  }
  return total / weight;
}

/* Splits hits into the ones worth keeping and the ones that are breathing,
 * mic bumps or room noise.
 *
 * `strictness` 0 keeps almost everything, 1 keeps only unmistakable hits.
 */
export function partitionHits(hits, { strictness = 0.5 } = {}) {
  if (hits.length < 3) return { kept: hits, rejected: [] };

  let loudest = 0;
  for (const hit of hits) loudest = Math.max(loudest, hit.originalPeak);

  const wash = washContext(hits);
  const scored = hits.map((hit, i) => ({ hit, score: breathScore(hit, loudest, wash[i]) }));

  // Centred on the sweep in tests/pipeline.mjs: at the default this keeps
  // every real hit in the fixture while rejecting eight of the nine breath
  // slices. Pushing it harder starts eating quiet kicks, and losing a hit you
  // performed is a worse failure than leaving one breath in.
  const threshold = 0.52 - (strictness - 0.5) * 0.3;

  let kept = scored.filter((s) => s.score < threshold);
  let rejected = scored.filter((s) => s.score >= threshold);

  // A take where most things look like breathing is far more likely to be a
  // quiet or distant recording than a performance of pure breathing. Rather
  // than gut it, keep the most percussive ones and let the user hear it.
  const floor = Math.max(2, Math.ceil(hits.length * 0.4));
  if (kept.length < floor) {
    scored.sort((a, b) => a.score - b.score);
    kept = scored.slice(0, floor);
    rejected = scored.slice(floor);
  }

  return {
    kept: kept.map((s) => s.hit),
    rejected: rejected.map((s) => ({ ...s.hit, breathScore: s.score })),
  };
}
