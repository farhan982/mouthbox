/* Rendering a song to a WAV file.
 *
 * Re-runs the same Engine inside an OfflineAudioContext, so what you download
 * is what you heard — same envelopes, filters, choking and limiter.
 */

import { Engine } from './engine.js';
import { collectEvents } from './sequencer.js';

export function encodeWav(channels, sampleRate) {
  const count = channels.length;
  const frames = channels[0].length;
  const bytes = frames * count * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/* The offline Engine needs the same AudioBuffers; they are plain data and the
 * sample rate matches, so they are reused rather than rebuilt. */
function bankAdapter(bank, offlineCtx) {
  return {
    ctx: offlineCtx,
    buffers: bank.buffers,
    reversed: bank.reversed,
    get: (id, reverse) => bank.get(id, reverse),
  };
}

export async function renderToWav({ bank, pads, patterns, chain, pattern, bpm, swing, repeats = 1, tailSeconds = 1.5 }) {
  const { events, duration } = collectEvents({
    pads, patterns, chain, pattern, bpm, swing, repeats,
  });
  if (!events.length) throw new Error('Nothing to export — the pattern is empty.');

  const sampleRate = bank.ctx.sampleRate;
  const length = Math.ceil((duration + tailSeconds) * sampleRate);
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new Ctor(2, length, sampleRate);

  const engine = new Engine(offline, bankAdapter(bank, offline));
  engine.sync(pads);

  for (const event of events) {
    engine.trigger(event.pad, event.time + 0.05, event.velocity, event.sampleId);
  }

  const rendered = await offline.startRendering();
  const channels = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    channels.push(rendered.getChannelData(c));
  }

  return { blob: encodeWav(channels, sampleRate), duration };
}

/* Exports one pad's sample on its own, for use in a real DAW. */
export function sampleToWav(bank, sampleId) {
  const buffer = bank.get(sampleId);
  if (!buffer) throw new Error('That sample is missing.');
  return encodeWav([buffer.getChannelData(0)], buffer.sampleRate);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
