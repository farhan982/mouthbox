/* The capture screen.
 *
 * Record a phrase, see what the analyser found, adjust if it got it wrong,
 * then build the kit. Everything transient (the take itself, the current
 * analysis) lives in this module rather than app state — it is megabytes of
 * audio and it does not need persisting until the kit is built.
 */

import * as state from '../state.js';
import { runtime, unlock, resetContext } from '../runtime.js';
import { Recorder } from '../audio/record.js';
import { prepare, analyze, commit, AnalysisError } from '../audio/analyze.js';
import { el, button, slider, confirmDialog, formatTime } from './ui.js';
import { drawWaveform, waveformCanvas, levelMeter } from './waveform.js';
import { padColor } from './colors.js';

let recorder = null;
let take = null;        // prepared take: { samples, sampleRate, env, tempo }
let result = null;      // latest analysis
let error = null;
let options = { sensitivity: 0.5, groups: 'auto' };
let elapsedTimer = null;
let metronome = { on: false, countIn: false };

function rerun(rerender) {
  if (!take) return;
  try {
    result = analyze(take, options);
    error = null;
  } catch (err) {
    result = null;
    error = err instanceof AnalysisError ? err.message : 'Analysis failed.';
  }
  rerender();
}

/* Which pad each onset ended up on, for colouring the waveform markers. */
function assignments() {
  if (!result) return [];
  const byHit = new Map();
  result.groups.forEach((group, padIndex) => {
    for (const hit of group.members) byHit.set(hit.index, padIndex);
  });
  return result.hits.map((hit) => byHit.get(hit.index));
}

function startMetronome() {
  if (!metronome.on) return null;
  const { ctx } = runtime();
  const beat = 60 / state.getKit().bpm;
  const stopAt = ctx.currentTime + 600;
  let time = ctx.currentTime + 0.1;
  const timers = [];

  // Scheduled in one pass: a recording is short, and this keeps the click off
  // the same timer that drives the UI.
  for (let i = 0; time < stopAt && i < 1200; i++, time += beat) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = i % 4 === 0 ? 1600 : 1100;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.18, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
    timers.push(osc);
  }
  return () => timers.forEach((osc) => { try { osc.stop(); } catch { /* done */ } });
}

export function renderRecord(root, rerender) {
  const kit = state.getKit();
  const recording = recorder?.recording === true;

  const wrap = el('div', { class: 'view view-record' });

  // --- transport -----------------------------------------------------------
  const meter = levelMeter();
  const timer = el('div', { class: 'take-timer', text: recording ? '0:00.0' : formatTime(take ? take.samples.length / take.sampleRate : 0) });

  const recordButton = el('button', {
    class: `record-button${recording ? ' is-recording' : ''}`,
    type: 'button',
    'aria-label': recording ? 'Stop recording' : 'Start recording',
    onClick: async () => {
      if (recording) {
        await stopRecording(rerender);
        return;
      }
      await startRecording(meter, rerender);
    },
  }, [el('span', { class: 'record-dot' })]);

  wrap.appendChild(el('div', { class: 'transport' }, [
    recordButton,
    el('div', { class: 'transport-info' }, [
      timer,
      meter.node,
      el('p', {
        class: 'hint',
        text: recording
          ? 'Beatbox a phrase. Tap again when you are done.'
          : 'Record four or eight bars of beatboxing. Loud, close to the mic, and leave the hits distinct.',
      }),
    ]),
  ]));

  if (recording) {
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      if (!recorder?.recording) return clearInterval(elapsedTimer);
      timer.textContent = formatTime(recorder.elapsed);
    }, 100);
  }

  // --- options -------------------------------------------------------------
  if (!recording && !take) {
    wrap.appendChild(el('div', { class: 'row row-wrap' }, [
      el('label', { class: 'toggle' }, [
        el('input', {
          type: 'checkbox',
          checked: metronome.on,
          onChange: (e) => { metronome.on = e.target.checked; rerender(); },
        }),
        el('span', { text: `Click track at ${kit.bpm} BPM` }),
      ]),
      el('p', { class: 'hint hint-inline', text: 'Off by default — the tempo is read from your groove instead.' }),
    ]));
  }

  // --- review --------------------------------------------------------------
  if (take && !recording) {
    const canvas = waveformCanvas();
    wrap.appendChild(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-body' }, [canvas]),
    ]));

    // Canvas needs layout before it can size itself.
    requestAnimationFrame(() => drawWaveform(canvas, {
      samples: take.samples,
      sampleRate: take.sampleRate,
      onsetTimes: result ? result.onsetTimes : [],
      assignments: assignments(),
    }));

    if (error) {
      wrap.appendChild(el('p', { class: 'notice notice-warn', text: error }));
    }

    if (result) {
      const confidence = Math.round(result.tempo.confidence * 100);
      wrap.appendChild(el('div', { class: 'stats' }, [
        stat('Hits', String(result.hits.length)),
        stat('Tempo', `${result.tempo.bpm} BPM`, confidence < 40 ? 'Low confidence — check it' : `${confidence}% confident`),
        stat('Pads', String(result.groups.length)),
        stat('Length', `${result.pattern.bars} bar${result.pattern.bars === 1 ? '' : 's'}`),
      ]));

      wrap.appendChild(el('div', { class: 'pad-preview' },
        result.groups.map((group, index) => el('div', { class: 'pad-chip' }, [
          el('span', { class: 'swatch', style: { background: padColor(index) } }),
          el('strong', { text: group.name }),
          el('span', { class: 'muted', text: `${group.members.length} hit${group.members.length === 1 ? '' : 's'}` }),
        ]))));
    }

    wrap.appendChild(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-body' }, [
        slider({
          label: 'Sensitivity',
          min: 0, max: 1, step: 0.02,
          value: options.sensitivity,
          format: (v) => (v < 0.34 ? 'catches ghost notes' : v > 0.7 ? 'only the obvious hits' : 'balanced'),
          onInput: (v) => { options.sensitivity = v; rerun(rerender); },
        }),
        el('div', { class: 'field' }, [
          el('span', { text: 'Pads' }),
          el('select', {
            onChange: (e) => {
              options.groups = e.target.value === 'auto' ? 'auto' : parseInt(e.target.value, 10);
              rerun(rerender);
            },
          }, ['auto', 2, 3, 4, 5, 6, 7, 8].map((value) => el('option', {
            value: String(value),
            selected: String(options.groups) === String(value),
            text: value === 'auto' ? 'Decide for me' : `${value} pads`,
          }))),
        ]),
        result ? slider({
          label: 'Tempo',
          min: 60, max: 200, step: 0.5,
          value: result.tempo.bpm,
          format: (v) => `${v} BPM`,
          onInput: (v) => { options.bpmOverride = v; rerun(rerender); },
        }) : null,
      ]),
    ]));

    wrap.appendChild(el('div', { class: 'row row-actions' }, [
      button('Build kit', () => buildKit(rerender), { class: 'btn btn-primary', disabled: !result }),
      button('Record again', () => discard(rerender), { class: 'btn' }),
    ]));
  }

  root.appendChild(wrap);
}

function stat(label, value, sub = null) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat-label', text: label }),
    el('strong', { class: 'stat-value', text: value }),
    sub ? el('span', { class: 'stat-sub', text: sub }) : null,
  ]);
}

async function startRecording(meter, rerender) {
  try {
    // Playback and capture on one context is asking for feedback, and the
    // context is about to be retired anyway.
    runtime().sequencer.stop();
    state.setUi({ playing: false });
    await unlock();
    recorder = new Recorder({ onLevel: (level) => meter.update(level) });
    await recorder.start();
    take = null;
    result = null;
    error = null;
    const stopClick = startMetronome();
    recorder.stopClick = stopClick;
    state.setStatus(null);
    rerender();
  } catch (err) {
    recorder = null;
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    state.setStatus(denied
      ? 'Microphone access was blocked. Allow it in your browser settings and try again.'
      : `Could not start recording: ${err.message}`);
    rerender();
  }
}

async function stopRecording(rerender) {
  clearInterval(elapsedTimer);
  if (recorder?.stopClick) recorder.stopClick();
  const captured = recorder.stop();
  recorder = null;

  // The context that held the microphone is retired here. On iOS it stays
  // wired to the earpiece once a mic has been opened on it, so everything
  // played back afterwards would be inaudible from the speaker.
  try {
    await resetContext();
  } catch {
    state.setStatus('Audio had to restart after recording. If playback is silent, reload the page.');
  }

  if (captured.duration < 0.4) {
    take = null;
    state.setStatus('That take was too short to analyse.');
    rerender();
    return;
  }

  try {
    take = prepare(captured.samples, captured.sampleRate);
    options = { sensitivity: 0.5, groups: 'auto' };
    rerun(rerender);
  } catch (err) {
    take = null;
    state.setStatus(err.message);
    rerender();
  }
}

async function buildKit(rerender) {
  if (!result) return;
  const kit = state.getKit();

  if (kit.pads.length) {
    const ok = await confirmDialog({
      title: 'Replace the current kit?',
      body: 'Building a kit from this take discards the pads and patterns you have now.',
      confirmLabel: 'Replace',
    });
    if (!ok) return;
  }

  const { bank } = runtime();
  bank.buffers.clear();
  bank.reversed.clear();
  bank.nextId = 1;

  const built = commit(result, bank);
  state.adoptAnalysis(built);
  take = null;
  result = null;
  rerender();
}

async function discard(rerender) {
  take = null;
  result = null;
  error = null;
  rerender();
}
