/**
 * Tiny local cache: IndexedDB (one object store, key/value) with an in-memory fallback
 * when IndexedDB is unavailable (private mode, file:// in some browsers, tests).
 *
 * Stores:
 *  - session snapshots  (`snapshot:<sessionId>`)  -> { ...SessionSnapshot, cachedAt }
 *  - session lists      (`sessions:<orgId>`)      -> { items: Session[], cachedAt }
 *  - anything else callers need, namespaced by key prefix.
 */
const DB_NAME = 'sf-claws';
const STORE = 'kv';
const VERSION = 1;

const memory = new Map();
let dbPromise = null;
let disabled = typeof indexedDB === 'undefined';

function openDb() {
  if (disabled) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      disabled = true;
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      disabled = true;
      resolve(null);
    };
    req.onblocked = () => {
      resolve(null);
    };
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(STORE, mode);
    } catch (e) {
      return reject(e);
    }
    const store = t.objectStore(STORE);
    let result;
    try {
      const r = fn(store);
      if (r && typeof r === 'object' && 'onsuccess' in r)
        r.onsuccess = () => {
          result = r.result;
        };
      else result = r;
    } catch (e) {
      return reject(e);
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

export const cache = {
  get isPersistent() {
    return !disabled;
  },

  async get(key, fallback = null) {
    if (memory.has(key)) return memory.get(key);
    const db = await openDb();
    if (!db) return fallback;
    try {
      const v = await tx(db, 'readonly', (s) => s.get(key));
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  },

  async set(key, value) {
    memory.set(key, value);
    const db = await openDb();
    if (!db) return;
    try {
      await tx(db, 'readwrite', (s) => s.put(value, key));
    } catch {
      /* quota / closed: keep memory copy */
    }
  },

  async remove(key) {
    memory.delete(key);
    const db = await openDb();
    if (!db) return;
    try {
      await tx(db, 'readwrite', (s) => s.delete(key));
    } catch {
      /* ignore */
    }
  },

  /** All keys with a prefix (memory + db). */
  async keys(prefix = '') {
    const out = new Set([...memory.keys()].filter((k) => k.startsWith(prefix)));
    const db = await openDb();
    if (db) {
      try {
        const all = await tx(db, 'readonly', (s) => s.getAllKeys());
        for (const k of all || []) if (String(k).startsWith(prefix)) out.add(String(k));
      } catch {
        /* ignore */
      }
    }
    return [...out];
  },

  async clear() {
    memory.clear();
    const db = await openDb();
    if (!db) return;
    try {
      await tx(db, 'readwrite', (s) => s.clear());
    } catch {
      /* ignore */
    }
  },
};

// ---- typed helpers ----------------------------------------------------------
const SNAP = 'snapshot:';
const LIST = 'sessions:';

export async function getCachedSnapshot(sessionId) {
  return sessionId ? cache.get(SNAP + sessionId) : null;
}
export async function putCachedSnapshot(sessionId, snapshot) {
  if (!sessionId || !snapshot) return;
  const { events, ...rest } = snapshot;
  // Keep the cache bounded: last 5000 events is plenty for an interactive session.
  await cache.set(SNAP + sessionId, { ...rest, events: (events || []).slice(-5000), cachedAt: new Date().toISOString() });
}
export async function removeCachedSnapshot(sessionId) {
  return cache.remove(SNAP + sessionId);
}

export async function getCachedSessionList(orgId) {
  return orgId ? cache.get(LIST + orgId) : null;
}
export async function putCachedSessionList(orgId, items) {
  if (orgId) await cache.set(LIST + orgId, { items: items || [], cachedAt: new Date().toISOString() });
}

/** Drop snapshots that are not in the given keep-set (called after listing sessions). */
export async function pruneSnapshots(keepIds, max = 30) {
  const keys = await cache.keys(SNAP);
  if (keys.length <= max) return;
  const keep = new Set(keepIds || []);
  for (const k of keys) {
    const id = k.slice(SNAP.length);
    if (!keep.has(id)) await cache.remove(k);
  }
}
