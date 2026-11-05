/* The pad grid and the pad inspector.
 *
 * Tap a pad to hear it, hold focus on it to shape it. Keyboard rows 1-8 map
 * to the pads so you can play with both hands on a laptop.
 */

import * as state from '../state.js';
import { runtime, unlock } from '../runtime.js';
import { sampleToWav, download } from '../audio/wav.js';
import { DRUM_TYPES, DRUM_PARAMS, suggestDrum } from '../audio/drums.js';
import { el, button, slider, confirmDialog } from './ui.js';
import { padColor } from './colors.js';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];

let keyHandler = null;

export function renderPads(root, rerender) {
  const kit = state.getKit();
  const ui = state.getUi();

  if (!kit.pads.length) {
    root.appendChild(el('div', { class: 'view empty' }, [
      el('h2', { text: 'No kit yet' }),
      el('p', { text: 'Record a phrase on the Record tab and the pads will build themselves.' }),
      button('Go to Record', () => state.setUi({ tab: 'record' }), { class: 'btn btn-primary' }),
    ]));
    return;
  }

  const { engine } = runtime();
  engine.sync(kit.pads);

  const wrap = el('div', { class: 'view view-pads' });

  const grid = el('div', { class: 'pad-grid' }, kit.pads.map((pad, index) => {
    const node = el('button', {
      class: `pad${ui.selectedPad === pad.id ? ' is-selected' : ''}${pad.mute ? ' is-muted' : ''}`,
      type: 'button',
      style: { '--pad-color': padColor(index) },
      onPointerDown: async () => {
        await unlock();
        engine.trigger(pad);
        node.classList.add('is-hit');
        setTimeout(() => node.classList.remove('is-hit'), 110);
        if (ui.selectedPad !== pad.id) state.setUi({ selectedPad: pad.id });
      },
    }, [
      el('span', { class: 'pad-key', text: KEYS[index] || '' }),
      el('span', { class: 'pad-name', text: pad.name }),
      el('span', { class: 'pad-count', text: `${pad.sampleIds.length} sample${pad.sampleIds.length === 1 ? '' : 's'}` }),
    ]);
    return node;
  }));

  wrap.appendChild(grid);

  const selected = state.getPad(ui.selectedPad) || kit.pads[0];
  wrap.appendChild(inspector(selected, kit.pads.indexOf(selected), rerender));

  root.appendChild(wrap);

  // Rebound on every render so it always sees the current pads.
  if (keyHandler) window.removeEventListener('keydown', keyHandler);
  keyHandler = async (event) => {
    if (event.target.matches('input, select, textarea')) return;
    const index = KEYS.indexOf(event.key);
    if (index < 0 || !kit.pads[index]) return;
    event.preventDefault();
    await unlock();
    engine.trigger(kit.pads[index]);
    const node = grid.children[index];
    if (node) {
      node.classList.add('is-hit');
      setTimeout(() => node.classList.remove('is-hit'), 110);
    }
  };
  window.addEventListener('keydown', keyHandler);
}

/* The synthesised drum sitting under this pad.
 *
 * Changing the voice resets its parameters to the tuning suggested for this
 * pad's own timbre, rather than carrying over values that meant something
 * else on a different voice. */
function drumSection(pad, update, rerender) {
  const drum = pad.drum || { type: 'none', blend: 0 };
  const setDrum = (patch) => update({ drum: { ...drum, ...patch } });

  const rows = [
    el('div', { class: 'field' }, [
      el('span', { text: 'Drum layer' }),
      el('select', {
        onChange: (e) => {
          const type = e.target.value;
          if (type === 'none') setDrum({ type: 'none' });
          else {
            const suggested = suggestDrum(pad.name, pad.tone || {});
            const fresh = suggested.type === type ? suggested : { type };
            setDrum({ ...fresh, type, blend: drum.blend || 0.5 });
          }
          rerender();
        },
      }, DRUM_TYPES.map((option) => el('option', {
        value: option.id,
        selected: drum.type === option.id,
        text: option.label,
      }))),
    ]),
  ];

  if (drum.type && drum.type !== 'none') {
    rows.push(slider({
      label: 'Blend',
      min: 0, max: 1, step: 0.02, value: drum.blend ?? 0,
      format: (v) => (v < 0.02 ? 'all you' : v > 0.98 ? 'all drum' : `${Math.round(v * 100)}% drum`),
      onInput: (v) => setDrum({ blend: v }),
    }));

    for (const param of DRUM_PARAMS[drum.type] || []) {
      rows.push(slider({
        label: param.label,
        min: param.min,
        max: param.max,
        step: param.step,
        value: drum[param.key] ?? param.fallback,
        format: param.format,
        onInput: (v) => setDrum({ [param.key]: v }),
      }));
    }
  }

  return el('div', { class: 'drum-section' }, [
    el('h3', { text: 'Real drum' }),
    ...rows,
  ]);
}

function inspector(pad, index, rerender) {
  if (!pad) return null;
  const { engine, bank } = runtime();
  const update = (patch) => {
    state.updatePad(pad.id, patch);
    engine.sync(state.getKit().pads);
  };

  const nameInput = el('input', {
    type: 'text',
    value: pad.name,
    class: 'name-input',
    onChange: (e) => state.renamePad(pad.id, e.target.value.trim()),
  });

  return el('section', { class: 'panel inspector', style: { '--pad-color': padColor(index) } }, [
    el('header', { class: 'panel-head' }, [
      nameInput,
      el('div', { class: 'row' }, [
        button(pad.mute ? 'Unmute' : 'Mute', () => { update({ mute: !pad.mute }); rerender(); },
          { class: `btn btn-small${pad.mute ? ' is-on' : ''}` }),
        button('Solo', () => { update({ solo: !pad.solo }); rerender(); },
          { class: `btn btn-small${pad.solo ? ' is-on' : ''}` }),
      ]),
    ]),
    el('div', { class: 'panel-body' }, [
      slider({
        label: 'Level', min: 0, max: 1.2, step: 0.01, value: pad.gain,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => update({ gain: v }),
      }),
      slider({
        label: 'Pitch', min: -24, max: 24, step: 1, value: pad.pitch,
        format: (v) => (v === 0 ? 'original' : `${v > 0 ? '+' : ''}${v} st`),
        onInput: (v) => update({ pitch: v }),
      }),
      slider({
        label: 'Pan', min: -1, max: 1, step: 0.05, value: pad.pan,
        format: (v) => (Math.abs(v) < 0.03 ? 'centre' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`),
        onInput: (v) => update({ pan: v }),
      }),
      slider({
        label: 'Decay', min: 0, max: 1.5, step: 0.01, value: pad.decay,
        format: (v) => (v === 0 ? 'full sample' : `${Math.round(v * 1000)} ms`),
        onInput: (v) => update({ decay: v }),
      }),
      el('div', { class: 'field' }, [
        el('span', { text: 'Filter' }),
        el('select', {
          onChange: (e) => { update({ filterType: e.target.value }); rerender(); },
        }, [
          ['none', 'Off'],
          ['lowpass', 'Low pass'],
          ['highpass', 'High pass'],
          ['bandpass', 'Band pass'],
        ].map(([value, label]) => el('option', {
          value, selected: pad.filterType === value, text: label,
        }))),
      ]),
      pad.filterType !== 'none' ? slider({
        label: 'Cutoff', min: 80, max: 16000, step: 10, value: pad.cutoff,
        format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`),
        onInput: (v) => update({ cutoff: v }),
      }) : null,
      pad.filterType !== 'none' ? slider({
        label: 'Resonance', min: 0.1, max: 14, step: 0.1, value: pad.resonance,
        format: (v) => v.toFixed(1),
        onInput: (v) => update({ resonance: v }),
      }) : null,
      el('div', { class: 'row row-wrap' }, [
        el('label', { class: 'toggle' }, [
          el('input', {
            type: 'checkbox', checked: pad.reverse,
            onChange: (e) => { update({ reverse: e.target.checked }); },
          }),
          el('span', { text: 'Reverse' }),
        ]),
        el('label', { class: 'toggle' }, [
          el('input', {
            type: 'checkbox', checked: pad.roundRobin,
            onChange: (e) => update({ roundRobin: e.target.checked }),
          }),
          el('span', { text: 'Cycle samples' }),
        ]),
        el('label', { class: 'toggle' }, [
          el('input', {
            type: 'checkbox', checked: pad.choke > 0,
            onChange: (e) => update({ choke: e.target.checked ? 1 : 0 }),
          }),
          el('span', { text: 'Choke' }),
        ]),
      ]),
      drumSection(pad, update, rerender),
      pad.sampleIds.length > 1 ? el('div', { class: 'sample-row' },
        pad.sampleIds.map((id, i) => button(`${i + 1}`, async () => {
          await unlock();
          engine.trigger(pad, undefined, 1, id);
        }, { class: 'btn btn-small' }))) : null,
      el('div', { class: 'row row-wrap' }, [
        button('Export sample', () => {
          try {
            const blob = sampleToWav(bank, pad.sampleIds[0]);
            download(blob, `${pad.name.replace(/\s+/g, '-').toLowerCase()}.wav`);
          } catch (err) {
            state.setStatus(err.message);
          }
        }, { class: 'btn btn-small' }),
        button('Delete pad', async () => {
          const ok = await confirmDialog({
            title: `Delete ${pad.name}?`,
            body: 'Its row is removed from every pattern as well.',
            confirmLabel: 'Delete',
          });
          if (ok) { state.deletePad(pad.id); rerender(); }
        }, { class: 'btn btn-small btn-danger' }),
      ]),
    ]),
  ]);
}
