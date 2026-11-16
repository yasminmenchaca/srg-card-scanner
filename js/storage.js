// storage.js — tiny IndexedDB wrapper.
//
// Two object stores:
//   kv      — key/value pairs: the cached card list, settings, box presets.
//   entries — one record per logged card (the local sync queue + session history).
//
// Everything returns a Promise so callers can use async/await.

const DB_NAME = 'srg-scanner';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('session', 'session');
        s.createIndex('status', 'status');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Run one request inside a transaction and resolve with its result. */
async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

// ---- key/value ----
export const kvGet = (key) => run('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => run('kv', 'readwrite', (s) => s.put(value, key));

// ---- entries ----
export const putEntry = (entry) => run('entries', 'readwrite', (s) => s.put(entry));
export const deleteEntry = (id) => run('entries', 'readwrite', (s) => s.delete(id));
export const allEntries = async () =>
  ((await run('entries', 'readonly', (s) => s.getAll())) || []).sort((a, b) => a.seq - b.seq);
export const entriesByStatus = async (status) =>
  ((await run('entries', 'readonly', (s) => s.index('status').getAll(status))) || []).sort(
    (a, b) => a.seq - b.seq
  );
export const entriesBySession = async (session) =>
  ((await run('entries', 'readonly', (s) => s.index('session').getAll(session))) || []).sort(
    (a, b) => a.seq - b.seq
  );

// ---- settings (stored under one kv key) ----
export const DEFAULT_SETTINGS = {
  url: '',            // Apps Script web app URL (…/exec)
  token: '',          // secret token from createToken()
  session: 'Box 1',   // written to Notes
  foil: false,
  minScore: 0.85,     // auto-accept threshold
  minGap: 0.08,       // top result must beat #2 by this much
  stableMs: 350,      // frame must be still this long before reading
  motion: 12,         // average pixel change (0–255) that counts as "card moving"
  still: 4,           // average pixel change below this counts as "still"
  syncEvery: 10,      // send automatically once this many entries are waiting
  threshold: false,   // black/white threshold before OCR
};

export async function loadSettings() {
  const saved = (await kvGet('settings')) || {};
  // Optional local config.js (gitignored) can pre-fill url/token for dev.
  const local = window.SRG_CONFIG || {};
  return { ...DEFAULT_SETTINGS, ...local, ...saved };
}
export const saveSettings = (s) => kvSet('settings', s);
