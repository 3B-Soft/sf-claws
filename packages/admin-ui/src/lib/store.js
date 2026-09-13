/**
 * Tiny reactive store. `createStore(initial)` returns { get, set, update, subscribe }.
 * `subscribe(fn)` calls fn immediately with the current value and returns an unsubscribe fn.
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(next) {
      if (next === state) return;
      state = next;
      listeners.forEach((l) => {
        try {
          l(state);
        } catch (e) {
          console.error(e);
        }
      });
    },
    update(fn) {
      this.set(fn(state));
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
  };
}

/** Minimal event emitter. */
export function createEmitter() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    emit(type, payload) {
      map.get(type)?.forEach((fn) => {
        try {
          fn(payload);
        } catch (e) {
          console.error(e);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// App-wide stores
// ---------------------------------------------------------------------------

/** { status: 'booting'|'anon'|'authed'|'pending'|'offline', user, health, error } */
export const authStore = createStore({ status: 'booting', user: null, health: null, error: null });

/** Toasts: [{ id, kind: 'success'|'error'|'info'|'warning', title, message }] */
export const toastStore = createStore([]);
let toastSeq = 0;
export function toast(kind, title, message, ttl = 4500) {
  const id = ++toastSeq;
  toastStore.update((list) => [...list, { id, kind, title, message }]);
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
  return id;
}
export function dismissToast(id) {
  toastStore.update((list) => list.filter((t) => t.id !== id));
}
toast.success = (title, message) => toast('success', title, message);
toast.error = (title, message) => toast('error', title, message, 7000);
toast.info = (title, message) => toast('info', title, message);
toast.warning = (title, message) => toast('warning', title, message, 6000);

/** Confirm dialog: `confirm({ title, message, confirmLabel, danger })` -> Promise<boolean>. */
export const confirmStore = createStore(null);
export function confirm(opts) {
  return new Promise((resolve) => {
    confirmStore.set({
      title: opts.title || 'Are you sure?',
      message: opts.message || '',
      confirmLabel: opts.confirmLabel || 'Confirm',
      cancelLabel: opts.cancelLabel || 'Cancel',
      danger: !!opts.danger,
      resolve: (v) => {
        confirmStore.set(null);
        resolve(v);
      },
    });
  });
}

/** UI prefs persisted per browser. */
const PREFS_KEY = 'sfclaws.prefs';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}
export const prefsStore = createStore({ sidebarCollapsed: false, ...loadPrefs() });
prefsStore.subscribe((p) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
});
