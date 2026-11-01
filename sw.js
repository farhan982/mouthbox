/* Offline cache.
 *
 * Cache-first for the app shell so it opens with no network. The version
 * string is bumped by hand; a new value drops the old cache on activate.
 */

const VERSION = 'mouthbox-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './assets/styles.css',
  './src/app.js',
  './src/state.js',
  './src/storage.js',
  './src/runtime.js',
  './src/audio/fft.js',
  './src/audio/onsets.js',
  './src/audio/slice.js',
  './src/audio/classify.js',
  './src/audio/tempo.js',
  './src/audio/analyze.js',
  './src/audio/engine.js',
  './src/audio/sequencer.js',
  './src/audio/record.js',
  './src/audio/recorder-worklet.js',
  './src/audio/wav.js',
  './src/views/ui.js',
  './src/views/colors.js',
  './src/views/waveform.js',
  './src/views/record.js',
  './src/views/pads.js',
  './src/views/steps.js',
  './src/views/song.js',
  './src/views/transport.js',
  './src/views/nav.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // Individually, so one missing file does not fail the whole install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
