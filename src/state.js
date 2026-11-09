/* App state.
 *
 * Mutations go through here and notify the UI. Persistence is debounced
 * because writing a kit means writing its audio, and nobody needs that to
 * happen on every drag of a cutoff slider.
 */

import { createId, saveKit, loadKit, getSetting, setSetting } from './storage.js';

const SAVE_DELAY = 1200;

let kit = emptyKit();
let ui = {
  tab: 'record',
  selectedPad: null,
  patternId: null,
  playing: false,
  take: null,        // { duration, hitCount, bpm, confidence } from the last analysis
  status: null,      // transient message for the user
};

const listeners = [];
let saveTimer = null;

function emptyKit() {
  return {
    id: createId(),
    name: 'Untitled kit',
    bpm: 120,
    swing: 0,
    masterGain: 0.9,
    pads: [],
    patterns: [],
    chain: [],
    samples: {},      // id -> { sampleRate, data: Float32Array }
    updatedAt: Date.now(),
  };
}

export function subscribe(fn) {
  listeners.push(fn);
}

function notify({ persist = true } = {}) {
  if (persist) {
    kit.updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveKit(kit).catch(() => {
        setStatus('Could not save — the browser may be out of storage.');
      });
    }, SAVE_DELAY);
  }
  listeners.forEach((fn) => fn());
}

/* Flushes a pending save immediately. Used before leaving the page. */
export function flush() {
  clearTimeout(saveTimer);
  return saveKit(kit).catch(() => {});
}

export function getKit() {
  return kit;
}

export function getUi() {
  return ui;
}

export function setUi(patch, { persist = false } = {}) {
  ui = { ...ui, ...patch };
  notify({ persist });
}

export function setStatus(message) {
  ui = { ...ui, status: message };
  notify({ persist: false });
}

export async function restore() {
  const lastId = await getSetting('lastKit');
  if (!lastId) return false;
  const stored = await loadKit(lastId);
  if (!stored) return false;
  kit = { ...emptyKit(), ...stored };
  ui = {
    ...ui,
    tab: kit.pads.length ? 'pads' : 'record',
    patternId: kit.patterns[0]?.id || null,
    selectedPad: kit.pads[0]?.id || null,
  };
  notify({ persist: false });
  return true;
}

export function remember() {
  return setSetting('lastKit', kit.id).catch(() => {});
}

/* Replaces the kit's pads and patterns with the result of an analysis.
 * The previous kit is discarded, so callers confirm first. */
export function adoptAnalysis({ pads, patterns, chain, tempo, samples, takeInfo }) {
  kit = {
    ...kit,
    bpm: Math.round(tempo.bpm),
    pads,
    patterns,
    chain,
    samples,
  };
  ui = {
    ...ui,
    tab: 'pads',
    patternId: patterns[0]?.id || null,
    selectedPad: pads[0]?.id || null,
    take: takeInfo,
    status: null,
  };
  remember();
  notify();
}

export function newKit() {
  kit = emptyKit();
  ui = { ...ui, tab: 'record', selectedPad: null, patternId: null, take: null, status: null };
  remember();
  notify();
}

export function loadKitData(data) {
  kit = { ...emptyKit(), ...data, id: data.id || createId() };
  ui = {
    ...ui,
    tab: kit.pads.length ? 'pads' : 'record',
    patternId: kit.patterns[0]?.id || null,
    selectedPad: kit.pads[0]?.id || null,
  };
  remember();
  notify();
}

export function renameKit(name) {
  kit.name = name || 'Untitled kit';
  notify();
}

export function setTempo(bpm) {
  kit.bpm = Math.max(40, Math.min(240, Math.round(bpm)));
  notify();
}

export function setSwing(swing) {
  kit.swing = Math.max(0, Math.min(1, swing));
  notify();
}

export function setMasterGain(value) {
  kit.masterGain = Math.max(0, Math.min(1, value));
  notify();
}

export function getPad(id) {
  return kit.pads.find((p) => p.id === id) || null;
}

export function updatePad(id, patch) {
  const pad = getPad(id);
  if (!pad) return;
  Object.assign(pad, patch);
  notify();
}

export function renamePad(id, name) {
  updatePad(id, { name: name || 'Pad' });
}

export function deletePad(id) {
  const index = kit.pads.findIndex((p) => p.id === id);
  if (index < 0) return;
  kit.pads.splice(index, 1);
  // Lanes are positional, so every pattern loses the same row.
  for (const pattern of kit.patterns) pattern.steps.splice(index, 1);
  if (ui.selectedPad === id) ui.selectedPad = kit.pads[0]?.id || null;
  notify();
}

export function currentPattern() {
  return kit.patterns.find((p) => p.id === ui.patternId) || kit.patterns[0] || null;
}

export function setStep(patternId, padIndex, step, cell) {
  const pattern = kit.patterns.find((p) => p.id === patternId);
  if (!pattern) return;
  if (!pattern.steps[padIndex]) return;
  pattern.steps[padIndex][step] = cell;
  notify();
}

export function toggleStep(patternId, padIndex, step, velocity = 0.9) {
  const pattern = kit.patterns.find((p) => p.id === patternId);
  if (!pattern) return;
  const lane = pattern.steps[padIndex];
  if (!lane) return;
  lane[step] = lane[step] ? null : { velocity };
  notify();
}

export function clearPattern(patternId) {
  const pattern = kit.patterns.find((p) => p.id === patternId);
  if (!pattern) return;
  pattern.steps = pattern.steps.map((lane) => lane.map(() => null));
  notify();
}

export function setPatternLength(patternId, length) {
  const pattern = kit.patterns.find((p) => p.id === patternId);
  if (!pattern) return;
  pattern.steps = pattern.steps.map((lane) => {
    const next = new Array(length).fill(null);
    for (let i = 0; i < Math.min(length, lane.length); i++) next[i] = lane[i];
    return next;
  });
  pattern.length = length;
  pattern.bars = Math.max(1, Math.round(length / 16));
  notify();
}

function nextPatternName() {
  const used = new Set(kit.patterns.map((p) => p.name));
  for (let i = 0; i < 26; i++) {
    const name = String.fromCharCode(65 + i);
    if (!used.has(name)) return name;
  }
  return `P${kit.patterns.length + 1}`;
}

export function addPattern({ copyFrom = null } = {}) {
  const source = copyFrom ? kit.patterns.find((p) => p.id === copyFrom) : null;
  const length = source?.length || 16;
  const pattern = {
    id: createId(),
    name: nextPatternName(),
    length,
    bars: Math.max(1, Math.round(length / 16)),
    stepsPerBeat: 4,
    steps: kit.pads.map((_, padIndex) => {
      const lane = new Array(length).fill(null);
      if (source?.steps[padIndex]) {
        for (let i = 0; i < length; i++) {
          const cell = source.steps[padIndex][i];
          lane[i] = cell ? { ...cell } : null;
        }
      }
      return lane;
    }),
  };
  kit.patterns.push(pattern);
  kit.chain.push({ patternId: pattern.id, repeats: 1 });
  ui = { ...ui, patternId: pattern.id };
  notify();
  return pattern;
}

export function deletePattern(id) {
  if (kit.patterns.length <= 1) return;
  kit.patterns = kit.patterns.filter((p) => p.id !== id);
  kit.chain = kit.chain.filter((entry) => entry.patternId !== id);
  if (ui.patternId === id) ui.patternId = kit.patterns[0].id;
  notify();
}

export function setChain(chain) {
  kit.chain = chain;
  notify();
}

export function addToChain(patternId) {
  kit.chain.push({ patternId, repeats: 1 });
  notify();
}

export function removeFromChain(index) {
  kit.chain.splice(index, 1);
  notify();
}

export function moveChainEntry(index, delta) {
  const target = index + delta;
  if (index < 0 || index >= kit.chain.length) return;
  if (target < 0 || target >= kit.chain.length) return;
  const [entry] = kit.chain.splice(index, 1);
  kit.chain.splice(target, 0, entry);
  notify();
}

export function duplicateChainEntry(index) {
  const entry = kit.chain[index];
  if (!entry) return;
  kit.chain.splice(index + 1, 0, { ...entry });
  notify();
}

export function setChainRepeats(index, repeats) {
  if (!kit.chain[index]) return;
  kit.chain[index].repeats = Math.max(1, Math.min(16, repeats));
  notify();
}
