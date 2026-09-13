/**
 * Promise-based wrappers around chrome.storage with an in-memory fallback so the side
 * panel can run as a plain web page (dev / tests) when `chrome` is undefined.
 */
const hasChrome = typeof chrome !== 'undefined' && !!chrome?.storage;
const memory = { sync: new Map(), local: new Map() };
const listeners = new Set();

function area(name) {
  if (hasChrome) return chrome.storage[name];
  const map = memory[name];
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : keys ? [keys] : [...map.keys()];
      const out = {};
      for (const k of list) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: map.get(k), newValue: v };
        map.set(k, v);
      }
      for (const fn of listeners) fn(changes, name);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const k of list) {
        changes[k] = { oldValue: map.get(k) };
        map.delete(k);
      }
      for (const fn of listeners) fn(changes, name);
    },
  };
}

// Web fallback: persist to localStorage so dev reloads keep the server URL.
if (!hasChrome && typeof localStorage !== 'undefined') {
  try {
    for (const name of ['sync', 'local']) {
      const raw = localStorage.getItem(`sfclaws.storage.${name}`);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) memory[name].set(k, v);
    }
    listeners.add((_, name) => {
      try {
        localStorage.setItem(`sfclaws.storage.${name}`, JSON.stringify(Object.fromEntries(memory[name])));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

async function getOne(name, key, fallback) {
  const res = await area(name).get(key);
  return res[key] === undefined ? fallback : res[key];
}

export const storage = {
  isChrome: hasChrome,
  sync: {
    get: (key, fallback) => getOne('sync', key, fallback),
    set: (key, value) => area('sync').set({ [key]: value }),
    remove: (key) => area('sync').remove(key),
  },
  local: {
    get: (key, fallback) => getOne('local', key, fallback),
    set: (key, value) => area('local').set({ [key]: value }),
    remove: (key) => area('local').remove(key),
  },
  /** Subscribe to changes: fn(changes, areaName). Returns unsubscribe. */
  onChanged(fn) {
    if (hasChrome) {
      chrome.storage.onChanged.addListener(fn);
      return () => chrome.storage.onChanged.removeListener(fn);
    }
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Keys used by the extension. */
export const KEYS = {
  serverUrl: 'serverUrl', // sync
  uiMode: 'uiMode', // sync
  notifications: 'notifications', // sync: system notification when an approval card waits (default on)
  token: 'token', // local
  tokenExpiresAt: 'tokenExpiresAt',
  user: 'user', // local (cached)
  lastSessionByOrg: 'lastSessionByOrg', // local
  orgByHost: 'orgByHost', // local: { [host]: { org, client, at } } — offline fallback for /orgs/resolve
};

export function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  try {
    const u = new URL(s);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}
