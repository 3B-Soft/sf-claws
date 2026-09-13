/**
 * Hash-based router. Routes look like `#/clients/:id?tab=orgs`.
 * `routeStore` holds { name, path, params, query, hash }. `navigate('/users')` updates the hash.
 */
import { createStore } from './store.js';

export const ROUTES = [
  { name: 'dashboard', pattern: '/' },
  { name: 'login', pattern: '/login' },
  { name: 'register', pattern: '/register' },
  { name: 'pair', pattern: '/pair' },
  { name: 'oauthResult', pattern: '/oauth-result' },
  { name: 'policy', pattern: '/policy' },
  { name: 'users', pattern: '/users' },
  { name: 'ai', pattern: '/ai' },
  { name: 'clients', pattern: '/clients' },
  { name: 'client', pattern: '/clients/:id' },
  { name: 'knowledge', pattern: '/knowledge' },
  { name: 'skills', pattern: '/skills' },
  { name: 'skill', pattern: '/skills/:id' },
  { name: 'sessions', pattern: '/sessions' },
  { name: 'session', pattern: '/sessions/:id' },
  { name: 'usage', pattern: '/usage' },
  { name: 'audit', pattern: '/audit' },
  { name: 'settings', pattern: '/settings' },
];

function compile(pattern) {
  const keys = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '/([^/]+)';
      }) +
      '/?$',
  );
  return { re, keys };
}
const compiled = ROUTES.map((r) => ({ ...r, ...compile(r.pattern) }));

export function parseHash(hash = window.location.hash) {
  let h = (hash || '').replace(/^#/, '');
  if (!h.startsWith('/')) h = '/' + h;
  const [pathPart, queryPart = ''] = h.split('?');
  const path = pathPart || '/';
  const query = {};
  new URLSearchParams(queryPart).forEach((v, k) => {
    query[k] = v;
  });
  for (const r of compiled) {
    const m = path.match(r.re);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { name: r.name, path, params, query, hash: h };
    }
  }
  return { name: 'notFound', path, params: {}, query, hash: h };
}

export const routeStore = createStore(parseHash());
window.addEventListener('hashchange', () => routeStore.set(parseHash()));

/** Navigate to a path (with or without leading '#'). `replace` avoids a history entry. */
export function navigate(path, { replace = false } = {}) {
  const target = '#' + (path.startsWith('#') ? path.slice(1) : path.startsWith('/') ? path : '/' + path);
  if (replace) {
    const url = window.location.pathname + window.location.search + target;
    window.history.replaceState(null, '', url);
    routeStore.set(parseHash(target));
  } else if (window.location.hash === target) {
    routeStore.set(parseHash(target));
  } else {
    window.location.hash = target;
  }
}

/** Update only the query string of the current route (e.g. tab switches). */
export function setQuery(patch, { replace = true } = {}) {
  const cur = routeStore.get();
  const q = { ...cur.query, ...patch };
  Object.keys(q).forEach((k) => {
    if (q[k] === undefined || q[k] === null || q[k] === '') delete q[k];
  });
  const s = new URLSearchParams(q).toString();
  navigate(cur.path + (s ? `?${s}` : ''), { replace });
}

export function href(path) {
  return '#' + path;
}
