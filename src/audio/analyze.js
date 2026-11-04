/* The whole capture-to-pattern pipeline.
 *
 * Take in, pads and a playable pattern out. This is the thing the app is for.
 *
 * Analysis is pure, so the sensitivity slider can re-run it on every drag
 * without touching app state. `commit` is the separate step that registers
 * audio and builds real pads.
 */

import { onsetEnvelope, pickOnsets } from './onsets.js';
import { sliceTake } from './slice.js';
import { partitionHits } from './breath.js';
import { classify } from './classify.js';
import { inferTempo, buildPattern } from './tempo.js';
import { defaultPad } from './engine.js';

/* Hats shouldn't ring over each other; everything else should. */
function chokeFor(name) {
  return /hat/i.test(name) ? 1 : 0;
}

export class AnalysisError extends Error {}

/* Envelope and tempo depend only on the take, so they are computed once and
 * handed back for reuse across sensitivity changes. */
export function prepare(samples, sampleRate) {
  if (!samples.length) throw new AnalysisError('That take is empty.');
  const env = onsetEnvelope(samples, sampleRate);
  const tempo = inferTempo(env);
  return { samples, sampleRate, env, tempo };
}

export function analyze(prepared, {
  sensitivity = 0.5,
  groups = 'auto',
  bpmOverride = null,
  ignoreBreaths = true,
  strictness = 0.5,
} = {}) {
  const { samples, sampleRate, env } = prepared;
  const onsets = pickOnsets(env, { sensitivity });

  if (onsets.length < 2) {
    throw new AnalysisError(
      `Only found ${onsets.length} hit${onsets.length === 1 ? '' : 's'}. ` +
      'Try a louder take, or turn sensitivity up.'
    );
  }

  const sliced = sliceTake(samples, sampleRate, onsets, env.timeOf);
  if (sliced.length < 2) throw new AnalysisError('Could not pull usable slices out of that take.');

  const { kept: hits, rejected } = ignoreBreaths
    ? partitionHits(sliced, { strictness })
    : { kept: sliced, rejected: [] };

  if (hits.length < 2) {
    throw new AnalysisError('Everything in that take looked like breathing or room noise.');
  }

  const padGroups = classify(hits, { groups });
  const tempo = bpmOverride
    ? { ...prepared.tempo, bpm: bpmOverride }
    : prepared.tempo;

  const pattern = buildPattern(padGroups, tempo);

  return {
    groups: padGroups,
    pattern,
    tempo,
    hits,
    rejected,
    onsets,
    // Only the hits that survived get a marker on the waveform; the rejected
    // ones are shown separately so you can see what was thrown away.
    onsetTimes: hits.map((h) => h.time),
    rejectedTimes: rejected.map((h) => h.time),
    duration: samples.length / sampleRate,
  };
}

/* Turns an analysis into pads, registered audio, and a pattern whose steps
 * point at the specific hit that produced them — so the first playback is the
 * performance, not a round-robin through the kit. */
export function commit(result, bank) {
  const samples = {};

  const pads = result.groups.map((group, index) => {
    const sampleIds = group.members.map((hit) => {
      const id = bank.add(hit.samples, hit.sampleRate);
      samples[id] = { sampleRate: hit.sampleRate, data: hit.samples };
      return id;
    });
    const pad = defaultPad(`p${index + 1}`, group.name, sampleIds);
    pad.choke = chokeFor(group.name);
    return pad;
  });

  const pattern = {
    ...result.pattern,
    id: 'pat1',
    name: 'A',
    steps: result.pattern.steps.map((lane, padIndex) => lane.map((cell) => {
      if (!cell) return null;
      const group = result.groups[padIndex];
      const position = group.members.findIndex((h) => h.index === cell.hitIndex);
      const sampleId = position >= 0 ? pads[padIndex].sampleIds[position] : null;
      return { velocity: cell.velocity, sampleId };
    })),
  };

  return {
    pads,
    pattern,
    samples,
    tempo: result.tempo,
    takeInfo: {
      duration: result.duration,
      hitCount: result.hits.length,
      bpm: result.tempo.bpm,
      confidence: result.tempo.confidence,
      padCount: pads.length,
    },
  };
}
