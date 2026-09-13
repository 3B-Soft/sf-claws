/**
 * Page recorder — runs in the page's own JavaScript world, which is the only place console output
 * and `fetch`/`XMLHttpRequest` can be observed. A content script cannot see them: it shares the DOM
 * but not the page's globals.
 *
 * It is not declared in the manifest. The background service worker injects `installRecorder`
 * with `chrome.scripting.executeScript({ world: 'MAIN' })` on demand, into the one tab a session
 * is open on, and hands it a per-injection nonce. Pages the user merely browses, and every other
 * Salesforce tab, never run it.
 *
 * What it does and does not do, deliberately:
 *
 * - **Ring buffers, small and fixed.** A Salesforce page is chatty. Keeping the last few hundred
 *   entries bounds memory on a tab left open all day, and a wrapped buffer reports how many it
 *   dropped so an agent never mistakes a truncated window for a quiet one.
 * - **Nothing on `window`.** The buffers live in this closure. The previous build exposed them on
 *   `window.__sfClawsRecorder`, where any script on the page could read them.
 * - **Answers only its own content script.** A request must come from this window, from this
 *   origin, and carry the nonce this injection was given. Another frame, an embedded page or a
 *   script guessing the channel name gets no answer. (Page code in the same world can still
 *   observe the postMessage exchange; what it would learn is the page's own console and network
 *   activity, which it already has.)
 * - **Scrubs before recording.** Query-string parameters that look like credentials (`sid`,
 *   `token`, `session`, `secret`, `password`, `key`, and variants) are replaced with `[redacted]`
 *   before a URL enters the buffer, so a session id in a Visualforce URL never leaves the page.
 * - **Response bodies only for failures.** A successful Aura action's body is the user's data;
 *   there is no diagnostic value in shipping it to a model. A failed one carries the error.
 * - **Never blocks the page.** Wrappers pass through first and record second, inside try/catch:
 *   a bug in here must never break the org the user is working in.
 * - **Nothing leaves the page on its own.** Entries sit here until the content script asks, which
 *   only happens when a session's agent explicitly requests a capture.
 *
 * `installRecorder` must stay self-contained: `executeScript({ func })` serialises the function
 * source, so it cannot reference anything outside its own body.
 *
 * @param {string} nonce Per-injection secret the content script must present.
 */
export function installRecorder(nonce) {
  const MAX_CONSOLE = 300;
  const MAX_NETWORK = 300;
  const MAX_TEXT = 4000;
  const MAX_BODY = 2000;
  const MAX_URL = 1000;
  const CHANNEL = 'sf-claws-recorder';
  const SECRET_PARAM =
    /^(sid|oid|token|access[_-]?token|refresh[_-]?token|session[_-]?id|session|secret|password|passwd|pwd|api[_-]?key|key|auth|authorization|bearer|jwt|csrf|xsrf)$/i;

  const state = { console: [], network: [], droppedConsole: 0, droppedNetwork: 0 };

  function push(list, entry, max, dropKey) {
    list.push(entry);
    while (list.length > max) {
      list.shift();
      state[dropKey]++;
    }
  }

  function stringify(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  /** Replace credential-looking query parameters (and hash parameters) before a URL is stored. */
  function scrubUrl(raw) {
    const s = String(raw || '');
    const q = s.indexOf('?');
    const h = s.indexOf('#');
    const cut = q < 0 ? h : h < 0 ? q : Math.min(q, h);
    if (cut < 0) return s.slice(0, MAX_URL);
    const scrubbed = s.slice(cut).replace(/([?#&;])([^=&#;]+)=([^&#;]*)/g, (m, sep, key, value) => {
      let name = key;
      try {
        name = decodeURIComponent(key);
      } catch {
        /* keep raw */
      }
      return SECRET_PARAM.test(name) && value ? `${sep}${key}=[redacted]` : m;
    });
    return (s.slice(0, cut) + scrubbed).slice(0, MAX_URL);
  }

  /** The first frame of the caller's stack that is not this file — where the log actually came from. */
  function callSite() {
    try {
      const lines = (new Error().stack || '').split('\n').slice(2);
      const frame = lines.find((l) => l.includes('http') && !l.includes('sf-claws'));
      return frame ? scrubUrl(frame.trim()).slice(0, 300) : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- console
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    // biome-ignore lint/suspicious/noConsole: wrapping console is the whole point of this file.
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = (...args) => {
      try {
        push(
          state.console,
          { at: new Date().toISOString(), level, text: args.map(stringify).join(' ').slice(0, MAX_TEXT), source: callSite() },
          MAX_CONSOLE,
          'droppedConsole',
        );
      } catch {
        /* recording must never break logging */
      }
      return original.apply(console, args);
    };
  }

  // Uncaught errors and rejections never reach console.error in every browser path, and they are
  // exactly what a "the page just breaks" report is about.
  window.addEventListener('error', (e) => {
    const where = e.filename ? `${scrubUrl(e.filename)}:${e.lineno}:${e.colno}` : null;
    push(
      state.console,
      { at: new Date().toISOString(), level: 'error', text: `Uncaught ${stringify(e.error || e.message)}`.slice(0, MAX_TEXT), source: where },
      MAX_CONSOLE,
      'droppedConsole',
    );
  });
  window.addEventListener('unhandledrejection', (e) => {
    push(
      state.console,
      { at: new Date().toISOString(), level: 'error', text: `Unhandled promise rejection: ${stringify(e.reason)}`.slice(0, MAX_TEXT), source: null },
      MAX_CONSOLE,
      'droppedConsole',
    );
  });

  // ---------------------------------------------------------------- network
  function record(method, url, status, startedAt, error, body) {
    push(
      state.network,
      {
        at: new Date(startedAt).toISOString(),
        method: String(method || 'GET').toUpperCase(),
        url: scrubUrl(url),
        status: status ?? null,
        durationMs: Math.round(performance.now() - startedAt.perf),
        error: error ? String(error).slice(0, 300) : null,
        responseBody: body ? String(body).slice(0, MAX_BODY) : null,
      },
      MAX_NETWORK,
      'droppedNetwork',
    );
  }
  const stamp = () => Object.assign(new Date(), { perf: performance.now() });

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const [input, init] = args;
      const started = stamp();
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = init?.method || (typeof input === 'object' && input?.method) || 'GET';
      return originalFetch.apply(this, args).then(
        (res) => {
          // Only a failure's body is read, and from a clone so the page still gets its own stream.
          if (!res.ok) {
            res
              .clone()
              .text()
              .then(
                (t) => record(method, url, res.status, started, null, t),
                () => record(method, url, res.status, started, null, null),
              );
          } else record(method, url, res.status, started, null, null);
          return res;
        },
        (err) => {
          record(method, url, null, started, err?.message || 'network error', null);
          throw err;
        },
      );
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR?.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const meta = new WeakMap();
    XHR.prototype.open = function (...args) {
      meta.set(this, { method: args[0], url: args[1] });
      return open.apply(this, args);
    };
    XHR.prototype.send = function (...args) {
      const m = meta.get(this);
      if (m) {
        const started = stamp();
        this.addEventListener('loadend', () => {
          try {
            const failed = !this.status || this.status >= 400;
            record(m.method, m.url, this.status || null, started, this.status ? null : 'request failed', failed ? safeText(this) : null);
          } catch {
            /* ignore */
          }
        });
      }
      return send.apply(this, args);
    };
  }
  function safeText(xhr) {
    try {
      return typeof xhr.responseText === 'string' ? xhr.responseText : null;
    } catch {
      return null; // responseType blob/arraybuffer throws on responseText
    }
  }

  // ---------------------------------------------------------------- handover
  // The content script asks with the nonce; we answer on the same channel with the same nonce.
  // Same window, same origin and the right nonce, or silence.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || d.channel !== CHANNEL || d.direction !== 'request' || d.nonce !== nonce) return;
    const { requestId, kind } = d;
    const payload =
      kind === 'network'
        ? { network: state.network.slice(), dropped: state.droppedNetwork }
        : { console: state.console.slice(), dropped: state.droppedConsole };
    window.postMessage({ channel: CHANNEL, direction: 'response', nonce, requestId, ...payload }, window.location.origin);
  });
}
