/* Arrangement and export.
 *
 * Patterns get chained into a song, and the whole thing renders to a WAV
 * through the same engine that plays it live.
 */

import * as state from '../state.js';
import { runtime } from '../runtime.js';
import { renderToWav, download } from '../audio/wav.js';
import { DRUM_TYPES } from '../audio/drums.js';
import { serializeKit, parseKit, listKits, loadKit, deleteKit } from '../storage.js';
import { el, button, slider, section, confirmDialog, formatTime } from './ui.js';

let exporting = false;
let savedKits = null;

export function renderSong(root, rerender) {
  const kit = state.getKit();
  const wrap = el('div', { class: 'view view-song' });

  // --- chain ---------------------------------------------------------------
  if (kit.patterns.length) {
    const rows = kit.chain.length
      ? kit.chain.map((entry, index) => {
        const pattern = kit.patterns.find((p) => p.id === entry.patternId);
        return el('div', { class: 'chain-row' }, [
          el('span', { class: 'chain-index', text: String(index + 1) }),
          el('strong', { text: pattern ? pattern.name : 'missing' }),
          el('label', { class: 'field field-inline' }, [
            el('span', { text: '×' }),
            el('input', {
              type: 'number', min: 1, max: 16, value: entry.repeats || 1, class: 'repeats-input',
              onChange: (e) => state.setChainRepeats(index, parseInt(e.target.value, 10) || 1),
            }),
          ]),
          el('span', { class: 'muted', text: pattern ? `${pattern.bars * (entry.repeats || 1)} bars` : '' }),
          button('Remove', () => state.removeFromChain(index), { class: 'btn btn-small' }),
        ]);
      })
      : [el('p', { class: 'muted', text: 'The song is empty. Add a pattern below.' })];

    wrap.appendChild(section('Song', [
      el('div', { class: 'chain' }, rows),
      el('div', { class: 'row row-wrap' },
        kit.patterns.map((p) => button(`+ ${p.name}`, () => state.addToChain(p.id), { class: 'btn btn-small' }))),
      el('p', { class: 'hint', text: 'Switch the transport to Song to play the chain instead of looping one pattern.' }),
    ]));
  }

  // --- drum layer ----------------------------------------------------------
  if (kit.pads.length) {
    const layered = kit.pads.filter((p) => p.drum && p.drum.type !== 'none');
    const average = layered.length
      ? layered.reduce((sum, p) => sum + (p.drum.blend || 0), 0) / layered.length
      : 0;

    wrap.appendChild(section('Real drums', [
      el('p', { class: 'hint', text: 'Each pad has a synthesised drum tuned to the sound you made. This slides every pad between your voice and the drums at once; the Pads tab sets them individually.' }),
      slider({
        label: 'Blend everything',
        min: 0, max: 1, step: 0.02, value: average,
        format: (v) => (v < 0.02 ? 'all you' : v > 0.98 ? 'all drums' : `${Math.round(v * 100)}% drums`),
        onInput: (v) => {
          for (const pad of kit.pads) {
            if (!pad.drum || pad.drum.type === 'none') continue;
            pad.drum.blend = v;
          }
          runtime().engine.sync(kit.pads);
        },
        onChange: () => state.setUi({}),
      }),
      el('div', { class: 'row row-wrap' },
        layered.map((pad) => el('span', { class: 'pad-chip' }, [
          el('strong', { text: pad.name }),
          el('span', { class: 'muted', text: DRUM_TYPES.find((t) => t.id === pad.drum.type)?.label || pad.drum.type }),
        ]))),
      layered.length < kit.pads.length
        ? el('p', { class: 'muted', text: `${kit.pads.length - layered.length} pad(s) have no drum layer. Pick one on the Pads tab.` })
        : null,
    ]));
  }

  // --- export --------------------------------------------------------------
  const repeatsInput = el('input', { type: 'number', min: 1, max: 32, value: 2, class: 'repeats-input' });

  wrap.appendChild(section('Export', [
    el('label', { class: 'field field-inline' }, [
      el('span', { text: 'Repeat the song' }),
      repeatsInput,
      el('span', { text: 'times' }),
    ]),
    el('div', { class: 'row row-wrap' }, [
      button(exporting ? 'Rendering…' : 'Export WAV', async () => {
        if (exporting) return;
        exporting = true;
        rerender();
        try {
          const { bank } = runtime();
          const patterns = new Map(kit.patterns.map((p) => [p.id, p]));
          const { blob, duration } = await renderToWav({
            bank,
            pads: kit.pads,
            patterns,
            chain: kit.chain.length ? kit.chain : null,
            pattern: state.currentPattern(),
            bpm: kit.bpm,
            swing: kit.swing,
            repeats: parseInt(repeatsInput.value, 10) || 1,
          });
          download(blob, `${kit.name.replace(/\s+/g, '-').toLowerCase()}.wav`);
          state.setStatus(`Exported ${formatTime(duration)} of audio.`);
        } catch (err) {
          state.setStatus(err.message);
        } finally {
          exporting = false;
          rerender();
        }
      }, { class: 'btn btn-primary', disabled: exporting || !kit.pads.length }),
      button('Export kit file', () => {
        const blob = new Blob([serializeKit(kit)], { type: 'application/json' });
        download(blob, `${kit.name.replace(/\s+/g, '-').toLowerCase()}.mouthbox.json`);
      }, { class: 'btn', disabled: !kit.pads.length }),
    ]),
    el('p', { class: 'hint', text: 'The WAV is rendered through the same engine you are hearing, so the export matches the preview. Individual pad samples export from the Pads tab.' }),
  ]));

  // --- kit -----------------------------------------------------------------
  const fileInput = el('input', {
    type: 'file', accept: '.json,application/json', class: 'hidden-file',
    onChange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const data = parseKit(await file.text());
        const ok = await confirmDialog({
          title: `Load “${data.name}”?`,
          body: 'This replaces the kit you have open.',
          confirmLabel: 'Load',
        });
        if (!ok) return;
        const { restoreSamples } = await import('../runtime.js');
        const { bank } = runtime();
        bank.buffers.clear();
        bank.reversed.clear();
        restoreSamples(data.samples);
        state.loadKitData(data);
      } catch (err) {
        state.setStatus(err.message);
      } finally {
        event.target.value = '';
      }
    },
  });

  wrap.appendChild(section('Kit', [
    el('label', { class: 'field' }, [
      el('span', { text: 'Name' }),
      el('input', {
        type: 'text', value: kit.name, class: 'name-input',
        onChange: (e) => state.renameKit(e.target.value.trim()),
      }),
    ]),
    slider({
      label: 'Master level', min: 0, max: 1, step: 0.01, value: kit.masterGain,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => {
        kit.masterGain = v;
        runtime().engine.setMasterGain(v);
      },
    }),
    el('div', { class: 'row row-wrap' }, [
      button('New kit', async () => {
        const ok = kit.pads.length ? await confirmDialog({
          title: 'Start a new kit?',
          body: 'The current kit stays saved in this browser and can be reopened below.',
          confirmLabel: 'New kit',
          danger: false,
        }) : true;
        if (!ok) return;
        await state.flush();
        state.newKit();
        savedKits = null;
      }, { class: 'btn' }),
      button('Import kit file', () => fileInput.click(), { class: 'btn' }),
      fileInput,
    ]),
    savedKitsList(rerender),
  ]));

  root.appendChild(wrap);
}

function savedKitsList(rerender) {
  if (savedKits === null) {
    listKits().then((kits) => { savedKits = kits; rerender(); }).catch(() => { savedKits = []; });
    return el('p', { class: 'muted', text: 'Looking for saved kits…' });
  }

  const others = savedKits.filter((k) => k.id !== state.getKit().id);
  if (!others.length) return null;

  return el('div', { class: 'saved-kits' }, [
    el('h3', { text: 'Saved in this browser' }),
    ...others.map((meta) => el('div', { class: 'saved-row' }, [
      el('strong', { text: meta.name }),
      el('span', { class: 'muted', text: `${meta.pads?.length || 0} pads · ${meta.bpm} BPM` }),
      button('Open', async () => {
        const data = await loadKit(meta.id);
        if (!data) return;
        await state.flush();
        const { restoreSamples } = await import('../runtime.js');
        const { bank } = runtime();
        bank.buffers.clear();
        bank.reversed.clear();
        restoreSamples(data.samples);
        state.loadKitData(data);
        savedKits = null;
      }, { class: 'btn btn-small' }),
      button('Delete', async () => {
        const ok = await confirmDialog({
          title: `Delete “${meta.name}”?`,
          body: 'This cannot be undone.',
          confirmLabel: 'Delete',
        });
        if (!ok) return;
        await deleteKit(meta.id);
        savedKits = null;
        rerender();
      }, { class: 'btn btn-small btn-danger' }),
    ])),
  ]);
}
