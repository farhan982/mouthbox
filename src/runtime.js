/* The live audio objects.
 *
 * Kept out of state.js: these are not data, they cannot be serialised, and
 * there is exactly one of each. Views import this rather than passing an
 * engine handle down through every function.
 */

import { audioContext, resume, resetAudioContext } from './audio/record.js';
import { SampleBank, Engine } from './audio/engine.js';
import { Sequencer } from './audio/sequencer.js';

let instance = null;

export function runtime() {
  if (!instance) {
    const ctx = audioContext();
    const bank = new SampleBank(ctx);
    const engine = new Engine(ctx, bank);
    const sequencer = new Sequencer(ctx, engine);
    instance = { ctx, bank, engine, sequencer };
  }
  return instance;
}

/* Browsers suspend a context created outside a gesture, so this is called
 * from the first click anywhere in the app. */
export async function unlock() {
  await resume();
  return runtime();
}

/* Rebuilds the context and everything hanging off it, carrying the samples
 * across. Called after recording, because on iOS the old context is stuck
 * routing to the earpiece once a microphone has been opened on it.
 */
export async function resetContext() {
  const previous = instance;
  const ctx = await resetAudioContext();

  const bank = previous ? previous.bank : new SampleBank(ctx);
  if (previous) bank.rehome(ctx);

  const engine = new Engine(ctx, bank);
  const sequencer = new Sequencer(ctx, engine);
  instance = { ctx, bank, engine, sequencer };
  return instance;
}

/* Loads persisted samples back into the bank after a reload. Keeps the
 * original ids so pads and pattern steps still resolve. */
export function restoreSamples(samples) {
  const { bank } = runtime();
  let highest = 0;
  for (const [id, entry] of Object.entries(samples || {})) {
    const buffer = bank.ctx.createBuffer(1, entry.data.length, entry.sampleRate);
    buffer.copyToChannel(entry.data instanceof Float32Array
      ? entry.data
      : Float32Array.from(entry.data), 0);
    bank.buffers.set(id, buffer);
    const n = parseInt(String(id).replace(/\D/g, ''), 10);
    if (Number.isFinite(n)) highest = Math.max(highest, n);
  }
  bank.nextId = highest + 1;
}
