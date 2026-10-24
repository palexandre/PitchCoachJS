// Per-device persistence for the example app: settings, best scores and imported songs.
// Everything is optional: in private mode or with storage blocked the app still works.

const PREFIX = 'pitchcoach:';

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

/** Borra todo lo que la app guardó en localStorage. */
export function clearAllJSON() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

export function removeJSON(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch { /* storage unavailable */ }
}

// ---- imported songs (IndexedDB, files can be bigger than localStorage allows) ----

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('pitchcoach', 1);
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

export async function clearImported() {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch { /* ignore */ }
}

export async function deleteImported(id) {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch { /* ignore */ }
}
