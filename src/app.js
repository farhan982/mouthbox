/* Bootstrap and the render loop.
 *
 * One full re-render per state change. The grid playhead and the input meter
 * are the exceptions — those touch the DOM directly, because they update far
 * too often to rebuild anything.
 */

import * as state from './state.js';
import { runtime, restoreSamples } from './runtime.js';
import { renderRecord } from './views/record.js';
import { renderPads } from './views/pads.js';
import { renderSteps, stopPlayhead } from './views/steps.js';
import { renderSong } from './views/song.js';
import { renderTransport, configureSequencer } from './views/transport.js';
import { buildNav } from './views/nav.js';
import { el, button } from './views/ui.js';

const root = document.getElementById('app');

function render() {
  stopPlayhead();
  const ui = state.getUi();
  const kit = state.getKit();

  root.innerHTML = '';

  root.appendChild(el('header', { class: 'app-head' }, [
    el('h1', { text: kit.name }),
    el('span', { class: 'muted', text: kit.pads.length ? `${kit.pads.length} pads · ${kit.bpm} BPM` : 'no kit yet' }),
  ]));

  if (kit.pads.length) {
    renderTransport(root);
    configureSequencer();
  }

  if (ui.status) {
    root.appendChild(el('div', { class: 'notice' }, [
      el('span', { text: ui.status }),
      button('✕', () => state.setStatus(null), { class: 'btn btn-tiny', 'aria-label': 'Dismiss' }),
    ]));
  }

  if (ui.tab === 'pads') renderPads(root, render);
  else if (ui.tab === 'steps') renderSteps(root, render);
  else if (ui.tab === 'song') renderSong(root, render);
  else renderRecord(root, render);

  root.appendChild(buildNav(ui.tab));
}

state.subscribe(render);

/* Spacebar is play/stop everywhere except inside a text field. */
window.addEventListener('keydown', async (event) => {
  if (event.code !== 'Space') return;
  if (event.target.matches('input, select, textarea, button')) return;
  event.preventDefault();
  const { togglePlay } = await import('./views/transport.js');
  await togglePlay();
});

/* A pending save is at most a second or so behind; flush it on the way out. */
window.addEventListener('pagehide', () => { state.flush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') state.flush();
});

async function boot() {
  runtime();
  try {
    const restored = await state.restore();
    if (restored) restoreSamples(state.getKit().samples);
  } catch {
    state.setStatus('Could not reopen your last kit.');
  }
  render();
}

boot();

// Offline support is best-effort: the app works without it, and service
// workers are unavailable on insecure origins.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
