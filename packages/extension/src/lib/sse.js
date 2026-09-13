/**
 * SSE client for GET /sessions/:id/events?after=<seq>&token=<jwt>.
 * Uses EventSource; reconnects manually with the latest seen seq so the server can resume.
 * Server may send either unnamed `data:` messages or named events (`event: <type>`), both handled.
 */
import { SESSION_EVENT_TYPES } from './transcript.js';

export function connectEvents({ urlFor, after = 0, onEvent, onStatus }) {
  let es = null;
  let lastSeq = after;
  let closed = false;
  let attempt = 0;
  let timer = null;

  const status = (s, extra) => {
    try {
      onStatus?.(s, extra);
    } catch {
      /* ignore */
    }
  };

  function handle(raw) {
    if (!raw) return;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    if (ev && typeof ev.seq === 'number') lastSeq = Math.max(lastSeq, ev.seq);
    onEvent(ev);
  }

  function open() {
    if (closed) return;
    cleanup();
    status(attempt ? 'reconnecting' : 'connecting', { attempt });
    try {
      es = new EventSource(urlFor(lastSeq));
    } catch (e) {
      status('error', { error: e });
      schedule();
      return;
    }
    es.onopen = () => {
      attempt = 0;
      status('open');
    };
    es.onmessage = (m) => handle(m.data);
    for (const t of SESSION_EVENT_TYPES) es.addEventListener(t, (m) => handle(m.data));
    // Server signals the end of the replay with `event: ready` {lastSeq, running}.
    es.addEventListener('ready', (m) => {
      let d = null;
      try {
        d = JSON.parse(m.data);
      } catch {
        d = null;
      }
      if (d && typeof d.lastSeq === 'number') lastSeq = Math.max(lastSeq, d.lastSeq);
      onEvent({ type: 'ready', lastSeq: d?.lastSeq, running: d?.running });
    });
    es.addEventListener('ping', () => {});
    es.onerror = () => {
      // EventSource would reconnect to the stale URL; do it ourselves with the fresh `after`.
      cleanup();
      status('error', { attempt });
      schedule();
    };
  }

  function schedule() {
    if (closed) return;
    attempt += 1;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)) + Math.random() * 300;
    timer = setTimeout(open, delay);
  }

  function cleanup() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
      es = null;
    }
  }

  open();
  return {
    close() {
      closed = true;
      cleanup();
      status('closed');
    },
    get lastSeq() {
      return lastSeq;
    },
    reconnectNow() {
      attempt = 0;
      open();
    },
  };
}
