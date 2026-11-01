/* Play, stop, tempo, swing. Pinned to the top so it is reachable from every
 * tab — you want to hear a change the moment you make it. */

import * as state from '../state.js';
import { runtime, unlock } from '../runtime.js';
import { el, button } from './ui.js';

export function configureSequencer() {
  const kit = state.getKit();
  const ui = state.getUi();
  const { sequencer, engine } = runtime();

  const patterns = new Map(kit.patterns.map((p) => [p.id, p]));
  const pattern = patterns.get(ui.patternId) || kit.patterns[0] || null;

  engine.setMasterGain(kit.masterGain);
  engine.sync(kit.pads);
  sequencer.configure({
    bpm: kit.bpm,
    swing: kit.swing,
    pads: kit.pads,
    patterns,
    pattern,
    chain: ui.playMode === 'song' ? kit.chain : null,
  });

  return sequencer;
}

export async function togglePlay() {
  await unlock();
  const sequencer = configureSequencer();
  if (sequencer.playing) {
    sequencer.stop();
    state.setUi({ playing: false });
  } else {
    sequencer.start();
    state.setUi({ playing: true });
  }
}

export function renderTransport(root) {
  const kit = state.getKit();
  const ui = state.getUi();
  const playing = runtime().sequencer.playing;

  const bar = el('div', { class: 'transport-bar' }, [
    button(playing ? '■' : '▶', togglePlay, {
      class: `btn btn-play${playing ? ' is-on' : ''}`,
      'aria-label': playing ? 'Stop' : 'Play',
    }),
    el('div', { class: 'tempo-control' }, [
      el('input', {
        type: 'number', min: 40, max: 240, value: kit.bpm, class: 'bpm-input',
        onChange: (e) => state.setTempo(parseFloat(e.target.value) || kit.bpm),
      }),
      el('span', { class: 'unit', text: 'BPM' }),
    ]),
    el('label', { class: 'swing-control' }, [
      el('span', { text: 'Swing' }),
      el('input', {
        type: 'range', min: 0, max: 0.9, step: 0.02, value: kit.swing,
        onInput: (e) => {
          const value = parseFloat(e.target.value);
          kit.swing = value;
          runtime().sequencer.configure({ swing: value });
        },
        onChange: (e) => state.setSwing(parseFloat(e.target.value)),
      }),
    ]),
    kit.patterns.length > 1 ? el('div', { class: 'mode-switch' }, [
      button('Loop', () => state.setUi({ playMode: 'pattern' }), {
        class: `btn btn-small${ui.playMode !== 'song' ? ' is-on' : ''}`,
      }),
      button('Song', () => state.setUi({ playMode: 'song' }), {
        class: `btn btn-small${ui.playMode === 'song' ? ' is-on' : ''}`,
      }),
    ]) : null,
  ]);

  root.appendChild(bar);
}
