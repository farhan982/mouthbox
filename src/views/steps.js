/* The step grid.
 *
 * One row per pad, one column per 16th. Click toggles, drag paints, and a
 * second click on an active step cycles its velocity so accents are a single
 * gesture rather than a trip to an inspector.
 *
 * The playhead is driven by rAF reading the sequencer's scheduled queue, not
 * by re-rendering — repainting this grid 16 times a bar would be absurd.
 */

import * as state from '../state.js';
import { runtime, unlock } from '../runtime.js';
import { configureSequencer } from './transport.js';
import { el, button, confirmDialog } from './ui.js';
import { padColor } from './colors.js';

const VELOCITIES = [0.45, 0.72, 1];

let frame = null;

function velocityTier(velocity) {
  if (velocity <= 0.55) return 0;
  if (velocity <= 0.85) return 1;
  return 2;
}

export function stopPlayhead() {
  if (frame) cancelAnimationFrame(frame);
  frame = null;
}

export function renderSteps(root, rerender) {
  const kit = state.getKit();
  const ui = state.getUi();

  if (!kit.pads.length) {
    root.appendChild(el('div', { class: 'view empty' }, [
      el('h2', { text: 'Nothing to sequence yet' }),
      el('p', { text: 'Build a kit from a take first.' }),
      button('Go to Record', () => state.setUi({ tab: 'record' }), { class: 'btn btn-primary' }),
    ]));
    return;
  }

  const pattern = state.currentPattern();
  if (!pattern) return;

  const { engine } = runtime();
  const wrap = el('div', { class: 'view view-steps' });

  // --- pattern picker ------------------------------------------------------
  wrap.appendChild(el('div', { class: 'row row-wrap pattern-bar' }, [
    el('div', { class: 'pattern-tabs' }, kit.patterns.map((p) => button(p.name, () => {
      state.setUi({ patternId: p.id });
    }, { class: `btn btn-small${p.id === pattern.id ? ' is-on' : ''}` }))),
    button('+ Pattern', () => state.addPattern({ copyFrom: pattern.id }), { class: 'btn btn-small' }),
    el('div', { class: 'spacer' }),
    el('label', { class: 'field field-inline' }, [
      el('span', { text: 'Bars' }),
      el('select', {
        onChange: (e) => state.setPatternLength(pattern.id, parseInt(e.target.value, 10) * 16),
      }, [1, 2, 4, 8].map((bars) => el('option', {
        value: String(bars), selected: pattern.bars === bars, text: String(bars),
      }))),
    ]),
    button('Clear', async () => {
      const ok = await confirmDialog({
        title: `Clear pattern ${pattern.name}?`,
        body: 'Every step in this pattern is removed. The pads and samples stay.',
        confirmLabel: 'Clear',
      });
      if (ok) state.clearPattern(pattern.id);
    }, { class: 'btn btn-small' }),
    kit.patterns.length > 1 ? button('Delete', async () => {
      const ok = await confirmDialog({
        title: `Delete pattern ${pattern.name}?`,
        confirmLabel: 'Delete',
      });
      if (ok) state.deletePattern(pattern.id);
    }, { class: 'btn btn-small btn-danger' }) : null,
  ]));

  // --- grid ---------------------------------------------------------------
  const grid = el('div', { class: 'grid' });
  const columns = [];

  // Beat ruler.
  const ruler = el('div', { class: 'grid-row grid-ruler' }, [el('div', { class: 'lane-label' })]);
  for (let step = 0; step < pattern.length; step++) {
    ruler.appendChild(el('div', {
      class: `ruler-cell${step % 4 === 0 ? ' is-beat' : ''}${step % 16 === 0 ? ' is-bar' : ''}`,
      text: step % 4 === 0 ? String(step / 4 + 1) : '',
    }));
  }
  grid.appendChild(ruler);

  let painting = null;   // 'on' | 'off' while dragging

  kit.pads.forEach((pad, padIndex) => {
    const row = el('div', { class: 'grid-row', style: { '--pad-color': padColor(padIndex) } });

    row.appendChild(el('button', {
      class: `lane-label${pad.mute ? ' is-muted' : ''}`,
      type: 'button',
      onClick: async () => {
        await unlock();
        engine.trigger(pad);
        state.setUi({ selectedPad: pad.id });
      },
    }, [
      el('span', { class: 'swatch', style: { background: padColor(padIndex) } }),
      el('span', { class: 'lane-name', text: pad.name }),
    ]));

    for (let step = 0; step < pattern.length; step++) {
      const cell = pattern.steps[padIndex]?.[step] || null;
      const node = el('button', {
        class: [
          'cell',
          cell ? 'is-on' : '',
          cell ? `v${velocityTier(cell.velocity)}` : '',
          step % 4 === 0 ? 'is-beat' : '',
          step % 16 === 0 ? 'is-bar' : '',
        ].filter(Boolean).join(' '),
        type: 'button',
        dataset: { step: String(step), pad: String(padIndex) },
        onPointerDown: async (event) => {
          event.preventDefault();
          await unlock();
          const existing = pattern.steps[padIndex][step];
          if (existing) {
            // Cycle the accent, then off at the top of the cycle.
            const tier = velocityTier(existing.velocity);
            if (tier < VELOCITIES.length - 1) {
              state.setStep(pattern.id, padIndex, step, {
                ...existing, velocity: VELOCITIES[tier + 1],
              });
              painting = 'on';
            } else {
              state.setStep(pattern.id, padIndex, step, null);
              painting = 'off';
            }
          } else {
            state.setStep(pattern.id, padIndex, step, { velocity: VELOCITIES[1] });
            engine.trigger(pad, undefined, VELOCITIES[1]);
            painting = 'on';
          }
        },
        onPointerEnter: () => {
          if (!painting) return;
          const existing = pattern.steps[padIndex][step];
          if (painting === 'on' && !existing) {
            state.setStep(pattern.id, padIndex, step, { velocity: VELOCITIES[1] });
          } else if (painting === 'off' && existing) {
            state.setStep(pattern.id, padIndex, step, null);
          }
        },
      });
      columns[step] = columns[step] || [];
      columns[step].push(node);
      row.appendChild(node);
    }

    grid.appendChild(row);
  });

  const endPaint = () => { painting = null; };
  window.addEventListener('pointerup', endPaint, { once: true });
  window.addEventListener('pointercancel', endPaint, { once: true });

  wrap.appendChild(el('div', { class: 'grid-scroll' }, [grid]));
  root.appendChild(wrap);

  startPlayhead(columns, pattern.id);
}

function startPlayhead(columns, patternId) {
  stopPlayhead();
  const { sequencer } = runtime();
  let lit = null;

  const tick = () => {
    const current = sequencer.currentStep();
    if (current && current.pattern === patternId) {
      if (lit != null && columns[lit]) {
        for (const node of columns[lit]) node.classList.remove('is-playing');
      }
      if (columns[current.step]) {
        for (const node of columns[current.step]) node.classList.add('is-playing');
        lit = current.step;
      }
    } else if (!sequencer.playing && lit != null) {
      if (columns[lit]) for (const node of columns[lit]) node.classList.remove('is-playing');
      lit = null;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

export { configureSequencer };
