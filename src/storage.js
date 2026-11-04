/* Persistence.
 *
 * IndexedDB rather than localStorage: a kit is raw PCM, and a few seconds of
 * beatboxing at 48 kHz is already past the 5 MB localStorage ceiling.
 * Float32Array survives structured clone, so samples go in as they are.
 */

const DB_NAME = 'mouthbox';
const DB_VERSION = 2;
const KITS = 'kits';
const SETTINGS = 'settings';

// Raw performance audio lives in its own store. A song-length take runs to
// tens of megabytes, and the kit record is rewritten on a debounce every time
// a slider moves — rewriting the audio alongside it would be ruinous.
const TAKES = 'takes';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KITS)) {
        db.createObjectStore(KITS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS);
      }
      if (!db.objectStoreNames.contains(TAKES)) {
        db.createObjectStore(TAKES, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function transact(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export function createId() {
  return Math.random().toString(36).slice(2, 10);
}

export function saveKit(kit) {
  return transact(KITS, 'readwrite', (store) => store.put(kit));
}

export function loadKit(id) {
  return transact(KITS, 'readonly', (store) => store.get(id));
}

export function listKits() {
  return transact(KITS, 'readonly', (store) => store.getAll())
    .then((kits) => kits
      .map(({ samples, ...meta }) => ({ ...meta, sampleCount: Object.keys(samples || {}).length }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
}

export function deleteKit(id) {
  return transact(KITS, 'readwrite', (store) => store.delete(id));
}

/* Raw take audio, keyed by kit id. Written only when a segment is added or
 * removed, never on the kit's debounced save. */
export function saveTake(kitId, timelineData) {
  return transact(TAKES, 'readwrite', (store) => store.put({ id: kitId, ...timelineData }));
}

export function loadTake(kitId) {
  return transact(TAKES, 'readonly', (store) => store.get(kitId));
}

export function deleteTake(kitId) {
  return transact(TAKES, 'readwrite', (store) => store.delete(kitId));
}

export function getSetting(key, fallback = null) {
  return transact(SETTINGS, 'readonly', (store) => store.get(key))
    .then((value) => (value === undefined ? fallback : value));
}

export function setSetting(key, value) {
  return transact(SETTINGS, 'readwrite', (store) => store.put(value, key));
}

/* Everything needed to rebuild a kit elsewhere, as a JSON-safe object.
 * Samples become plain arrays, which is wasteful on disk but means a backup
 * is a file anyone can read. */
export function serializeKit(kit) {
  const samples = {};
  for (const [id, data] of Object.entries(kit.samples || {})) {
    samples[id] = { sampleRate: data.sampleRate, data: Array.from(data.data) };
  }
  return JSON.stringify({ format: 'mouthbox-kit', version: 1, kit: { ...kit, samples } }, null, 2);
}

export function parseKit(text) {
  const parsed = JSON.parse(text);
  if (parsed.format !== 'mouthbox-kit') throw new Error('That is not a Mouthbox kit file.');
  const kit = parsed.kit;
  const samples = {};
  for (const [id, entry] of Object.entries(kit.samples || {})) {
    samples[id] = { sampleRate: entry.sampleRate, data: Float32Array.from(entry.data) };
  }
  return { ...kit, samples };
}
