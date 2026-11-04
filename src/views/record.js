/* The capture screen.
 *
 * A song is recorded in as many passes as you need. The first pass sets the
 * tempo; every pass after that gets a count-in and a click locked to it, and
 * is stitched onto the next bar line — so the breaks between takes vanish and
 * what comes back is one continuous performance.
 *
 * Everything transient (the audio, the current analysis) lives in this module
 * rather than in app state: it is tens of megabytes and it is persisted
 * separately, only when a segment is actually added or removed.
 */

import * as state from '../state.js';
import { runtime, unlock, resetContext } from '../runtime.js';
import { Recorder } from '../audio/record.js';
import { Timeline } from '../audio/timeline.js';
import { prepare, analyze, commit, AnalysisError } from '../audio/analyze.js';
import { saveTake, loadTake, deleteTake } from '../storage.js';
import { el, button, slider, confirmDialog, formatTime } from './ui.js';
import { drawWaveform, waveformCanvas, levelMeter } from './waveform.js';
import { padColor } from './colors.js';

const CLICK_LEAD = 0.12;   // breathing room before the count-in's first beat

let timeline = new Timeline();
let loadedFor = null;      // kit id whose take is currently loaded
let recorder = null;
let prepared = null;       // prepared analysis of the whole timeline
let result = null;         // latest analysis
let builtFromTake = false;
let error = null;
let countingIn = false;
let options = { sensitivity: 0.5, groups: 'auto', strictness: 0.5, ignoreBreaths: true };
let elapsedTimer = null;
// Off for a first take, so the tempo comes from the performance rather than
// the performance being pinned to an arbitrary tempo. Continuations force it
// on regardless: a part that drifts cannot be stitched to a bar line.
let useClick = false;

/* --- analysis ------------------------------------------------------------- */

function reanalyse(rerender) {
  if (timeline.isEmpty) {
    prepared = null;
    result = null;
    return;
  }
  try {
    const rendered = timeline.render();
    prepared = prepare(rendered.samples, rendered.sampleRate);
    result = analyze(prepared, options);
    error = null;
    // The first pass establishes the grid everything else is stitched to.
    if (!timeline.bpm) timeline.setTempo(result.tempo.bpm);
  } catch (err) {
    result = null;
    error = err instanceof AnalysisError ? err.message : 'Analysis failed.';
  }
  if (rerender) rerender();
}

function rerun(rerender) {
  if (!prepared) return;
  try {
    result = analyze(prepared, options);
    error = null;
  } catch (err) {
    result = null;
    error = err instanceof AnalysisError ? err.message : 'Analysis failed.';
  }
  rerender();
}

/* Which pad each surviving hit landed on, for colouring the waveform. */
function assignments() {
  if (!result) return [];
  const byHit = new Map();
  result.groups.forEach((group, padIndex) => {
    for (const hit of group.members) byHit.set(hit.index, padIndex);
  });
  return result.hits.map((hit) => byHit.get(hit.index));
}

/* --- click track ---------------------------------------------------------- */

/* Schedules a click at `bpm` for `seconds`, starting at `startAt`.
 * Returns a function that silences whatever has not played yet. */
function scheduleClick(bpm, startAt, seconds) {
  const { ctx } = runtime();
  const beat = 60 / bpm;
  const voices = [];
  let time = startAt;

  for (let i = 0; time < startAt + seconds && i < 4000; i++, time += beat) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = i % 4 === 0 ? 1600 : 1100;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.2, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.07);
    voices.push(osc);
  }

  return () => voices.forEach((osc) => { try { osc.stop(); } catch { /* done */ } });
}

/* --- persistence ---------------------------------------------------------- */

async function ensureLoaded(rerender) {
  const kitId = state.getKit().id;
  if (loadedFor === kitId) return;
  loadedFor = kitId;
  try {
    const stored = await loadTake(kitId);
    if (stored && stored.segments?.length) {
      timeline = Timeline.fromJSON(stored);
      builtFromTake = state.getKit().pads.length > 0;
      reanalyse(rerender);
    } else {
      timeline = new Timeline();
    }
  } catch {
    timeline = new Timeline();
  }
}

function persist() {
  const kitId = state.getKit().id;
  if (timeline.isEmpty) return deleteTake(kitId).catch(() => {});
  return saveTake(kitId, timeline.toJSON()).catch(() => {
    state.setStatus('Could not save the recording — the browser may be out of storage.');
  });
}

/* --- view ----------------------------------------------------------------- */

export function renderRecord(root, rerender) {
  ensureLoaded(rerender);

  const recording = recorder?.recording === true;
  const wrap = el('div', { class: 'view view-record' });
  const meter = levelMeter();

  const timer = el('div', {
    class: 'take-timer',
    text: recording ? '0:00.0' : formatTime(timeline.endTime),
  });

  const label = timeline.isEmpty ? 'Start recording' : 'Record the next part';
  const recordButton = el('button', {
    class: `record-button${recording ? ' is-recording' : ''}${countingIn ? ' is-counting' : ''}`,
    type: 'button',
    'aria-label': recording ? 'Stop recording' : label,
    disabled: countingIn,
    onClick: async () => {
      if (recording) await stopRecording(rerender);
      else await startRecording(meter, rerender);
    },
  }, [el('span', { class: 'record-dot' })]);

  let hint;
  if (countingIn) hint = 'Counting in…';
  else if (recording) hint = 'Go. Tap again when you need a break.';
  else if (timeline.isEmpty) hint = 'Record the first part. Whatever tempo you perform at becomes the song’s tempo.';
  else hint = `Picks up at bar ${Math.round(timeline.nextStart() / (timeline.barDuration || 1)) + 1}. `
    + 'You get a bar of count-in, then a click to keep you in time.';

  wrap.appendChild(el('div', { class: 'transport' }, [
    recordButton,
    el('div', { class: 'transport-info' }, [
      timer,
      meter.node,
      el('p', { class: 'hint', text: hint }),
    ]),
  ]));

  if (recording) {
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      if (!recorder?.recording) return clearInterval(elapsedTimer);
      timer.textContent = formatTime(recorder.elapsed);
    }, 100);
  }

  if (!recording && !countingIn) {
    if (timeline.isEmpty) {
      wrap.appendChild(el('label', { class: 'toggle' }, [
        el('input', {
          type: 'checkbox',
          checked: useClick,
          onChange: (e) => { useClick = e.target.checked; rerender(); },
        }),
        el('span', { text: `Record to a click at ${state.getKit().bpm} BPM` }),
      ]));
      wrap.appendChild(el('p', {
        class: 'hint',
        text: 'Off by default: the tempo is read from your groove instead of pinning you to one.',
      }));
    } else {
      wrap.appendChild(el('p', {
        class: 'hint',
        text: `The click runs at ${Math.round(timeline.bpm || state.getKit().bpm)} BPM while you record, `
          + 'so the parts line up when they are stitched together.',
      }));
    }
  }

  if (!timeline.isEmpty && !recording) {
    wrap.appendChild(segmentList(rerender));
    wrap.appendChild(review(rerender));
  }

  root.appendChild(wrap);
}

function segmentList(rerender) {
  const bar = timeline.barDuration;
  return el('section', { class: 'panel' }, [
    el('header', { class: 'panel-head' }, [
      el('h2', { text: `Parts (${timeline.segments.length})` }),
      el('span', { class: 'muted', text: `${formatTime(timeline.endTime)} total` }),
    ]),
    el('div', { class: 'panel-body' }, [
      el('div', { class: 'segments' }, timeline.segments.map((segment, i) => el('div', {
        class: 'segment-row',
      }, [
        el('span', { class: 'chain-index', text: String(i + 1) }),
        el('span', { text: bar ? `bar ${Math.round(segment.startTime / bar) + 1}` : 'start' }),
        el('span', { class: 'muted', text: formatTime(segment.duration) }),
        button('Delete', async () => {
          const ok = await confirmDialog({
            title: `Delete part ${i + 1}?`,
            body: 'The parts after it shift back to close the gap.',
            confirmLabel: 'Delete',
          });
          if (!ok) return;
          timeline.remove(segment.id);
          await persist();
          reanalyse(rerender);
          rerender();
        }, { class: 'btn btn-small btn-danger' }),
      ]))),
      button('Clear the whole recording', async () => {
        const ok = await confirmDialog({
          title: 'Delete the whole recording?',
          body: 'Every part is removed. The kit you have built stays until you rebuild.',
          confirmLabel: 'Delete all',
        });
        if (!ok) return;
        timeline.clear();
        await persist();
        prepared = null;
        result = null;
        builtFromTake = false;
        rerender();
      }, { class: 'btn btn-small' }),
    ]),
  ]);
}

function review(rerender) {
  const wrap = el('div', {});
  const canvas = waveformCanvas();
  wrap.appendChild(el('div', { class: 'panel' }, [el('div', { class: 'panel-body' }, [canvas])]));

  const rendered = timeline.render();
  requestAnimationFrame(() => drawWaveform(canvas, {
    samples: rendered.samples,
    sampleRate: rendered.sampleRate,
    onsetTimes: result ? result.onsetTimes : [],
    assignments: assignments(),
    rejectedTimes: result ? result.rejectedTimes : [],
  }));

  if (error) wrap.appendChild(el('p', { class: 'notice notice-warn', text: error }));

  if (result) {
    const confidence = Math.round(result.tempo.confidence * 100);
    wrap.appendChild(el('div', { class: 'stats' }, [
      stat('Hits', String(result.hits.length)),
      stat('Tempo', `${result.tempo.bpm} BPM`,
        confidence < 40 ? 'Low confidence — check it' : `${confidence}% confident`),
      stat('Pads', String(result.groups.length)),
      stat('Ignored', String(result.rejected.length), 'breaths and noise'),
    ]));

    wrap.appendChild(el('div', { class: 'pad-preview' },
      result.groups.map((group, index) => el('div', { class: 'pad-chip' }, [
        el('span', { class: 'swatch', style: { background: padColor(index) } }),
        el('strong', { text: group.name }),
        el('span', { class: 'muted', text: `${group.members.length}` }),
      ]))));
  }

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-body' }, [
      slider({
        label: 'Sensitivity',
        min: 0, max: 1, step: 0.02, value: options.sensitivity,
        format: (v) => (v < 0.34 ? 'catches ghost notes' : v > 0.7 ? 'only the obvious hits' : 'balanced'),
        onInput: (v) => { options.sensitivity = v; rerun(rerender); },
      }),
      el('label', { class: 'toggle' }, [
        el('input', {
          type: 'checkbox',
          checked: options.ignoreBreaths,
          onChange: (e) => { options.ignoreBreaths = e.target.checked; rerun(rerender); },
        }),
        el('span', { text: 'Ignore breathing and room noise' }),
      ]),
      options.ignoreBreaths ? slider({
        label: 'How much to ignore',
        min: 0.15, max: 0.85, step: 0.02, value: options.strictness,
        format: (v) => (v < 0.4 ? 'only obvious breaths' : v > 0.65 ? 'anything soft' : 'balanced'),
        onInput: (v) => { options.strictness = v; rerun(rerender); },
      }) : null,
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
        min: 60, max: 200, step: 0.5, value: result.tempo.bpm,
        format: (v) => `${v} BPM`,
        onInput: (v) => { options.bpmOverride = v; rerun(rerender); },
      }) : null,
    ]),
  ]));

  wrap.appendChild(el('div', { class: 'row row-actions' }, [
    button(builtFromTake ? 'Rebuild kit' : 'Build kit', () => buildKit(rerender),
      { class: 'btn btn-primary', disabled: !result }),
  ]));

  if (builtFromTake) {
    wrap.appendChild(el('p', {
      class: 'hint',
      text: 'The recording stays here. Change anything above and rebuild — you never need to perform it again.',
    }));
  }

  return wrap;
}

function stat(label, value, sub = null) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat-label', text: label }),
    el('strong', { class: 'stat-value', text: value }),
    sub ? el('span', { class: 'stat-sub', text: sub }) : null,
  ]);
}

/* --- recording ------------------------------------------------------------ */

async function startRecording(meter, rerender) {
  try {
    runtime().sequencer.stop();
    state.setUi({ playing: false });
    await unlock();

    const { ctx } = runtime();
    const bpm = timeline.bpm || state.getKit().bpm;
    const continuing = !timeline.isEmpty;
    const countIn = continuing ? timeline.countInDuration() : 0;

    recorder = new Recorder({ onLevel: (level) => meter.update(level) });
    await recorder.start();

    // Capture starts now; the performer starts after the count-in, so that
    // much is trimmed off the front when the segment is stored.
    const startAt = ctx.currentTime + CLICK_LEAD;
    recorder.trimLead = countIn > 0 ? CLICK_LEAD + countIn : 0;

    if (useClick || continuing) {
      // Runs through the whole take, not just the count-in — without it you
      // drift, and a drifting part cannot be stitched to a bar line.
      recorder.stopClick = scheduleClick(bpm, startAt, countIn + 600);
    }

    if (countIn > 0) {
      countingIn = true;
      rerender();
      setTimeout(() => { countingIn = false; rerender(); }, (CLICK_LEAD + countIn) * 1000);
    }

    error = null;
    state.setStatus(null);
    rerender();
  } catch (err) {
    recorder = null;
    countingIn = false;
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    state.setStatus(denied
      ? 'Microphone access was blocked. Allow it in your browser settings and try again.'
      : `Could not start recording: ${err.message}`);
    rerender();
  }
}

async function stopRecording(rerender) {
  clearInterval(elapsedTimer);
  countingIn = false;
  if (recorder?.stopClick) recorder.stopClick();
  const trimLead = recorder?.trimLead || 0;
  const captured = recorder.stop();
  recorder = null;

  // The context that held the microphone is retired here. On iOS it stays
  // wired to the earpiece once a mic has been opened on it.
  try {
    await resetContext();
  } catch {
    state.setStatus('Audio had to restart after recording. If playback is silent, reload the page.');
  }

  if (captured.duration - trimLead < 0.4) {
    state.setStatus('That part was too short to use.');
    rerender();
    return;
  }

  timeline.sampleRate = captured.sampleRate;
  timeline.add(captured.samples, { sampleRate: captured.sampleRate, trimLead });
  await persist();
  reanalyse(rerender);
  rerender();
}

async function buildKit(rerender) {
  if (!result) return;
  const kit = state.getKit();

  if (kit.pads.length && !builtFromTake) {
    const ok = await confirmDialog({
      title: 'Replace the current kit?',
      body: 'Building from this recording discards the pads and patterns you have now.',
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
  builtFromTake = true;
  rerender();
}
