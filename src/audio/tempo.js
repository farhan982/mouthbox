/* Working out the tempo and downbeat of a take, then turning the hits into a
 * step pattern.
 *
 * This is the part that decides whether the app feels like magic or like a
 * chore. Get the tempo right and the pattern you performed is just sitting
 * there on the grid when the analysis finishes.
 */

const MIN_BPM = 60;
const MAX_BPM = 200;
const PREFERRED_BPM = 124;   // beatboxers cluster around here
const STEPS_PER_BEAT = 4;    // 16th-note grid

/* Scores a tempo by how much onset energy lands on its beats.
 *
 * A comb filter, essentially: lay a pulse train at this period over the onset
 * envelope and sum what lines up. Returns the best phase too, which is the
 * downbeat.
 */
function scoreTempo(flux, frameRate, bpm) {
  const period = (60 / bpm) * frameRate;
  if (period < 2 || period > flux.length) return { score: 0, phase: 0 };

  const beats = Math.floor(flux.length / period);
  if (beats < 2) return { score: 0, phase: 0 };

  let best = { score: 0, phase: 0 };
  const phaseStep = Math.max(1, Math.round(period / 48));

  for (let phase = 0; phase < period; phase += phaseStep) {
    let score = 0;
    for (let b = 0; b < beats; b++) {
      const centre = phase + b * period;
      // A beat rarely lands exactly on a frame; take the local max.
      const lo = Math.max(0, Math.round(centre) - 1);
      const hi = Math.min(flux.length - 1, Math.round(centre) + 1);
      let peak = 0;
      for (let i = lo; i <= hi; i++) if (flux[i] > peak) peak = flux[i];
      score += peak;
    }
    score /= beats;
    if (score > best.score) best = { score, phase };
  }

  return best;
}

/* Octave errors are the classic failure here — 75 BPM and 150 BPM score
 * almost identically. Weight toward the range people actually perform in. */
function octaveWeight(bpm) {
  const octaves = Math.log2(bpm / PREFERRED_BPM);
  return Math.exp(-(octaves ** 2) / 0.5);
}

export function inferTempo(env, { min = MIN_BPM, max = MAX_BPM } = {}) {
  const { flux, frameRate } = env;
  if (!flux.length) return { bpm: 120, phase: 0, confidence: 0 };

  // Half-wave rectify around the mean so sustained noise doesn't contribute.
  const mean = flux.reduce((s, v) => s + v, 0) / flux.length;
  const signal = Float32Array.from(flux, (v) => Math.max(0, v - mean));

  let best = null;
  for (let bpm = min; bpm <= max; bpm += 0.25) {
    const { score, phase } = scoreTempo(signal, frameRate, bpm);
    const weighted = score * octaveWeight(bpm);
    if (!best || weighted > best.weighted) best = { bpm, phase, score, weighted };
  }

  if (!best) return { bpm: 120, phase: 0, confidence: 0 };

  // Confidence: how far the winner stands above a flat-ish baseline.
  let baseline = 0;
  let samples = 0;
  for (let bpm = min; bpm <= max; bpm += 2) {
    baseline += scoreTempo(signal, frameRate, bpm).score;
    samples++;
  }
  baseline /= Math.max(1, samples);
  const confidence = baseline > 0
    ? Math.max(0, Math.min(1, (best.score / baseline - 1) / 1.5))
    : 0;

  return {
    bpm: Math.round(best.bpm * 10) / 10,
    phase: best.phase / frameRate,   // seconds until the first downbeat
    confidence,
  };
}

/* Places each hit on the 16th-note grid.
 *
 * Velocity comes from the hit's original peak, so the pattern keeps the
 * dynamics that were performed rather than flattening everything to full.
 */
export function buildPattern(pads, tempo, { maxBars = 8 } = {}) {
  const stepDuration = 60 / tempo.bpm / STEPS_PER_BEAT;

  let loudest = 0;
  for (const pad of pads) {
    for (const hit of pad.members) loudest = Math.max(loudest, hit.originalPeak);
  }

  const placed = [];
  let highestStep = 0;

  pads.forEach((pad, padIndex) => {
    for (const hit of pad.members) {
      const step = Math.round((hit.time - tempo.phase) / stepDuration);
      if (step < 0) continue;
      highestStep = Math.max(highestStep, step);
      const velocity = loudest > 0
        ? Math.max(0.25, Math.min(1, hit.originalPeak / loudest))
        : 0.8;
      placed.push({ padIndex, step, velocity, hitIndex: hit.index });
    }
  });

  // Round up to whole bars, so the loop sounds like a loop.
  const stepsPerBar = STEPS_PER_BEAT * 4;
  const bars = Math.max(1, Math.min(maxBars, Math.ceil((highestStep + 1) / stepsPerBar)));
  const length = bars * stepsPerBar;

  const steps = Array.from({ length: pads.length }, () => new Array(length).fill(null));
  for (const note of placed) {
    if (note.step >= length) continue;
    const existing = steps[note.padIndex][note.step];
    // Two hits quantised onto one step: keep the louder.
    if (!existing || note.velocity > existing.velocity) {
      steps[note.padIndex][note.step] = {
        velocity: note.velocity,
        hitIndex: note.hitIndex,
      };
    }
  }

  return { length, bars, steps, stepsPerBeat: STEPS_PER_BEAT };
}

export { STEPS_PER_BEAT };
