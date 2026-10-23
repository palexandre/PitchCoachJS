// Per-device persistence for the example app: settings, best scores and imported songs.
// Everything is optional: in private mode or with storage blocked the app still works.

const PREFIX = 'entona:';

export function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

// ---- imported songs (IndexedDB, files can be bigger than localStorage allows) ----

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('entona', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('songs', mode);
    const req = fn(t.objectStore('songs'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function listImported() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return all.sort((a, b) => b.addedAt - a.addedAt);
  } catch {
    return [];
  }
}

export async function saveImported(entry) {
  try {
    await tx('readwrite', (s) => s.put(entry));
  } catch { /* not persisted, still playable this session */ }
}

export async function deleteImported(id) {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch { /* ignore */ }
}
