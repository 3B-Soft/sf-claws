/**
 * SSE client for `GET /sessions/:id/events?after=<seq>&token=<jwt>` with automatic reconnect,
 * resuming from the last received `seq`.
 */
import { SESSION_EVENT_TYPES } from '@sf-claws/shared';
import { sseUrl } from './api.js';

/** Every SessionEvent type, derived from the shared schema so a new event cannot be missed. */
export const EVENT_TYPES = SESSION_EVENT_TYPES;

export function connectSessionEvents(sessionId, { after = 0, onEvent, onStatus, onReady } = {}) {
  let lastSeq = after;
  let es = null;
  let closed = false;
  let retry = 0;
  let timer = null;

  const setStatus = (s) => {
    try {
      onStatus?.(s);
    } catch (e) {
      console.error(e);
    }
  };

  function open() {
    if (closed) return;
    try {
      es = new EventSource(sseUrl(sessionId, lastSeq));
    } catch (e) {
      console.error('SSE open failed', e);
      scheduleRetry();
      return;
    }
    setStatus('connecting');
    es.onopen = () => {
      retry = 0;
      setStatus('open');
    };
    es.onmessage = (msg) => {
      if (!msg.data) return;
      let ev;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (typeof ev?.seq === 'number') lastSeq = Math.max(lastSeq, ev.seq);
      try {
        onEvent?.(ev);
      } catch (e) {
        console.error(e);
      }
    };
    // The server emits named events (`event: <type>`), which EventSource does NOT route to onmessage.
    EVENT_TYPES.forEach((t) => es.addEventListener(t, (msg) => es.onmessage(msg)));
    // `ready` is sent once after replay: { lastSeq, running }.
    es.addEventListener('ready', (msg) => {
      let info = null;
      try {
        info = JSON.parse(msg.data);
      } catch {
        /* ignore */
      }
      if (typeof info?.lastSeq === 'number') lastSeq = Math.max(lastSeq, info.lastSeq);
      try {
        onReady?.(info);
      } catch (e) {
        console.error(e);
      }
    });
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      setStatus('reconnecting');
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (closed) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(retry++, 5));
    timer = setTimeout(open, delay);
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      es?.close();
      es = null;
      setStatus('closed');
    },
    get lastSeq() {
      return lastSeq;
    },
  };
}
