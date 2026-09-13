/**
 * Owns the open session: snapshot (server or local cache), transcript, SSE connection,
 * workspace/deploys/docs/notes/permissions. Lives outside components so tab switches keep
 * the stream alive.
 *
 * Load strategy (extension brief, "Local cache & recovery"):
 *   1. render immediately from the IndexedDB snapshot when one exists,
 *   2. fetch GET /sessions/:id/snapshot, replace the cached copy, re-render,
 *   3. open SSE with after=lastSeq to reconcile and stream live events,
 *   4. persist the snapshot again on every relevant change (debounced).
 * When the server is unreachable the panel stays usable read-only and shows "offline — last synced".
 */
import { createStore } from './store.js';
import { createTranscript } from './transcript.js';
import { connectEvents } from './sse.js';
import { api, appStore, currentPageContextForApi, setOrgLimits } from './state.js';
import { asList, apiEvents } from './api.js';
import { getBrowserCapture, armRecorder, reportAwaitingCards } from './bridge.js';
import { getCachedSnapshot, putCachedSnapshot } from './cache.js';

const initial = () => ({
  sessionId: null,
  loading: false,
  error: null,
  session: null,
  detail: null,
  items: [],
  agents: [],
  todos: [],
  notes: [], // Note[] (full content from /notes or the snapshot)
  permissions: [], // { command, grantedAt }[]
  status: 'idle',
  statusMessage: null,
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
  connection: 'closed', // connecting | open | reconnecting | error | closed
  pending: [], // unresolved confirmations
  contextPressure: null, // session.context: {level, percent, message} or null once dismissed
  workspace: [],
  deploys: [],
  docs: [],
  sending: false,
  resuming: false,
  offline: false, // server unreachable; rendering from cache
  fromCache: false, // current view came from the local cache
  lastSyncedAt: null, // ISO time of the last successful server sync
  lastSeq: 0,
  version: 0,
});

export const sessionStore = createStore(initial());

let transcript = null;
let stream = null;
let refreshTimer = null;
let persistTimer = null;
let currentId = null;
let rawEvents = []; // events kept for the local snapshot (bounded)

/**
 * Keep the background informed of how many approval cards await on this session. It owns the
 * icon badge and the notification; the panel is the only thing holding the event stream, so
 * it has to be the one to say.
 */
let lastAwaiting = { count: -1, sessionId: null, visible: null };
function reportAwaiting() {
  const pending = transcript?.pendingConfirmations || [];
  const visible = typeof document === 'undefined' ? true : !document.hidden;
  const next = { count: pending.length, sessionId: currentId, visible };
  if (next.count === lastAwaiting.count && next.sessionId === lastAwaiting.sessionId && next.visible === lastAwaiting.visible) return;
  lastAwaiting = next;
  reportAwaitingCards({ count: next.count, sessionId: currentId, title: pending[0]?.title || '', tabId: appStore.get().tabId, panelVisible: visible });
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', reportAwaiting);

function publish(extra = {}) {
  if (!transcript) return;
  // The action badge and the "a card is waiting" notification live in the service worker; it only
  // learns about confirmations from here, because the panel is what holds the event stream.
  reportAwaiting();
  sessionStore.set((s) => ({
    items: [...transcript.items],
    agents: transcript.agents,
    todos: transcript.todos,
    status: transcript.status,
    statusMessage: transcript.statusMessage,
    usage: { ...transcript.usage },
    pending: transcript.pendingConfirmations,
    contextPressure: transcript.contextPressure,
    costLimit: transcript.costLimit,
    lastSeq: transcript.lastSeq,
    version: s.version + 1,
    ...extra,
  }));
}

/** Apply a snapshot-like payload (SessionSnapshot or the cached copy) to a fresh transcript. */
function applySnapshot(snap, { fromCache }) {
  const session = snap.session;
  transcript = createTranscript();
  transcript.status = session?.status || 'idle';
  transcript.usage = {
    inputTokens: session?.inputTokens || 0,
    outputTokens: session?.outputTokens || 0,
    cachedInputTokens: session?.cachedInputTokens || 0,
    costUsd: session?.costUsd || 0,
  };
  rawEvents = Array.isArray(snap.events) ? snap.events.slice() : [];
  transcript.applyAll(rawEvents);
  transcript.seedPending(snap.pendingConfirmations);
  transcript.seedTodos(snap.todos);
  transcript.seedNotes(snap.notes);
  if (typeof snap.lastSeq === 'number') transcript.lastSeq = snap.lastSeq;
  if (snap.running && transcript.status !== 'awaiting_confirmation') transcript.status = 'running';
  sessionStore.set({
    session,
    detail: snap,
    workspace: snap.workspace || [],
    deploys: snap.deploys || [],
    docs: snap.docs || [],
    notes: snap.notes || [],
    permissions: snap.permissions || sessionStore.get().permissions || [],
    fromCache,
    lastSyncedAt: fromCache ? snap.cachedAt || null : new Date().toISOString(),
  });
  if (!fromCache && transcript.limits) setOrgLimits(transcript.limits);
  publish({ loading: false, error: null });
}

/** Build the object we persist locally (SessionSnapshot shape + a few extras). */
function localSnapshot() {
  const s = sessionStore.get();
  return {
    session: s.session,
    events: rawEvents,
    todos: transcript?.todos || [],
    notes: s.notes,
    workspace: s.workspace,
    deploys: s.deploys,
    docs: s.docs,
    pendingConfirmations: (transcript?.pendingConfirmations || []).map((c) => ({
      id: c.confirmationId,
      kind: c.confirmationKind,
      title: c.title,
      description: c.description,
      impact: c.impact ?? null,
      details: c.details,
      options: c.options,
      command: c.command,
      at: c.at,
    })),
    permissions: s.permissions,
    lastSeq: transcript?.lastSeq || 0,
    running: s.status === 'running',
    snapshotAt: s.lastSyncedAt || new Date().toISOString(),
  };
}
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (currentId && transcript) putCachedSnapshot(currentId, localSnapshot());
  }, 800);
}

export async function openSession(sessionId) {
  if (sessionId === currentId && transcript) return;
  closeSession();
  if (!sessionId) return;
  currentId = sessionId;
  transcript = createTranscript();
  sessionStore.set({ ...initial(), sessionId, loading: true });
  // A session is open on this tab: this is the moment the page recorder is allowed to start.
  const { tabId } = appStore.get();
  if (tabId != null) void armRecorder(tabId);

  // 1. local cache first
  let cached = null;
  try {
    cached = await getCachedSnapshot(sessionId);
  } catch {
    cached = null;
  }
  if (currentId !== sessionId) return;
  if (cached?.session) applySnapshot(cached, { fromCache: true });

  // 2. server snapshot
  try {
    const snap = await api.snapshot(sessionId).catch(async (e) => {
      if (!e.isNotFound) throw e;
      // Older servers: fall back to detail + history.
      const detail = await api.session(sessionId);
      const history = asList(await api.history(sessionId, 0).catch(() => []), 'events');
      return { ...detail, events: history, todos: [], notes: [], snapshotAt: new Date().toISOString() };
    });
    if (currentId !== sessionId) return;
    applySnapshot(snap, { fromCache: false });
    sessionStore.set({ offline: false });
    putCachedSnapshot(sessionId, localSnapshot());
    // side data that is not part of the snapshot
    loadPermissions();
    connect(sessionId);
  } catch (e) {
    if (currentId !== sessionId) return;
    if (e.isNetwork && cached?.session) {
      sessionStore.set({ loading: false, offline: true, error: null });
      connect(sessionId); // keeps retrying with backoff; will reconcile when the server is back
    } else if (e.isNetwork) {
      sessionStore.set({ loading: false, offline: true, error: 'Cannot reach the server and no local copy of this session exists yet.' });
      connect(sessionId);
    } else {
      sessionStore.set({ loading: false, error: e.message || 'Failed to load session' });
    }
  }
}

function connect(sessionId) {
  stream?.close();
  stream = connectEvents({
    urlFor: (after) => api.eventsUrl(sessionId, after),
    after: transcript.lastSeq,
    onEvent: (ev) => {
      if (currentId !== sessionId) return;
      if (ev && ev.type === 'ready') {
        onReady(sessionId, ev);
        return;
      }
      if (!transcript.apply(ev)) return;
      if (typeof ev.seq === 'number') {
        rawEvents.push(ev);
        if (rawEvents.length > 5000) rawEvents = rawEvents.slice(-5000);
      }
      if (
        [
          'workspace.file',
          'deploy.validation',
          'deploy.result',
          'deploy.verified',
          'doc.written',
          'github.commit',
          'note.written',
          'confirmation.resolved',
        ].includes(ev.type)
      )
        scheduleRefresh(ev.type);
      if (ev.type === 'browser.request') void answerBrowserRequest(sessionId, ev);
      if (ev.type === 'session.status') sessionStore.set((s) => ({ session: s.session ? { ...s.session, status: ev.status } : s.session }));
      if (ev.type === 'org.limits' && ev.limits) setOrgLimits(ev.limits);
      if (ev.type === 'session.usage')
        sessionStore.set((s) => ({
          session: s.session
            ? { ...s.session, inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedInputTokens: ev.cachedInputTokens, costUsd: ev.costUsd }
            : s.session,
        }));
      publish();
      schedulePersist();
    },
    onStatus: (status) => {
      if (currentId !== sessionId) return;
      const patch = { connection: status };
      if (status === 'open') {
        patch.offline = false;
        patch.fromCache = false;
        patch.lastSyncedAt = new Date().toISOString();
      }
      sessionStore.set(patch);
    },
  });
}

/** Server sends `event: ready` {lastSeq, running} after replaying — reconcile status. */
function onReady(sessionId, ev) {
  if (typeof ev.lastSeq === 'number') transcript.lastSeq = ev.lastSeq;
  if (ev.running === false && transcript.status === 'running') {
    // The loop is not running but we think it is: refresh the session row to get the real status.
    api
      .session(sessionId)
      .then((d) => {
        if (currentId !== sessionId) return;
        const s = d.session || d;
        transcript.status = s.status;
        sessionStore.set({ session: s });
        publish();
        schedulePersist();
      })
      .catch(() => {});
  } else if (ev.running === true && transcript.status !== 'running' && transcript.status !== 'awaiting_confirmation') {
    transcript.status = 'running';
  }
  if (sessionStore.get().fromCache) sessionStore.set({ fromCache: false, offline: false, lastSyncedAt: new Date().toISOString() });
  publish();
  schedulePersist();
}

function scheduleRefresh(type) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshSide(type);
  }, 600);
}

export async function refreshSide(type) {
  const id = currentId;
  if (!id) return;
  const tasks = [];
  if (!type || type === 'workspace.file' || type === 'deploy.validation' || type === 'deploy.result')
    tasks.push(
      api
        .workspace(id)
        .then((w) => ({ workspace: asList(w, 'workspace') }))
        .catch(() => null),
    );
  if (!type || type.startsWith('deploy.'))
    tasks.push(
      api
        .deploys(id)
        .then((d) => ({ deploys: asList(d, 'deploys') }))
        .catch(() => null),
    );
  if (!type || type === 'doc.written')
    tasks.push(
      api
        .docs(id)
        .then((d) => ({ docs: asList(d, 'docs') }))
        .catch(() => null),
    );
  if (!type || type === 'note.written')
    tasks.push(
      api
        .notes(id)
        .then((n) => ({ notes: asList(n, 'notes') }))
        .catch(() => null),
    );
  if (!type || type === 'confirmation.resolved')
    tasks.push(
      api
        .permissions(id)
        .then((p) => ({ permissions: asList(p, 'permissions') }))
        .catch(() => null),
    );
  const results = await Promise.all(tasks);
  if (currentId !== id) return;
  const patch = Object.assign({}, ...results.filter(Boolean));
  if (Object.keys(patch).length) {
    sessionStore.set(patch);
    schedulePersist();
  }
}

export async function loadPermissions() {
  const id = currentId;
  if (!id) return;
  try {
    const p = asList(await api.permissions(id), 'permissions');
    if (currentId === id) sessionStore.set({ permissions: p });
  } catch {
    /* optional */
  }
}
export async function revokePermission(command) {
  const id = currentId;
  if (!id) return;
  await api.revokePermission(id, command);
  sessionStore.set((s) => ({ permissions: (s.permissions || []).filter((p) => p.command !== command) }));
  schedulePersist();
}

export function closeSession() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (currentId && transcript) putCachedSnapshot(currentId, localSnapshot());
  }
  stream?.close();
  stream = null;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  transcript = null;
  currentId = null;
  rawEvents = [];
  sessionStore.set(initial());
  reportAwaiting();
}

export function reconnect() {
  if (currentId) connect(currentId);
}

/** Re-fetch the snapshot from the server (e.g. after coming back online). */
export async function resync() {
  const id = currentId;
  if (!id) return;
  try {
    const snap = await api.snapshot(id);
    if (currentId !== id) return;
    applySnapshot(snap, { fromCache: false });
    sessionStore.set({ offline: false });
    putCachedSnapshot(id, localSnapshot());
    loadPermissions();
    connect(id);
  } catch (e) {
    if (currentId === id) sessionStore.set({ offline: !!e.isNetwork, error: e.isNetwork ? null : e.message });
  }
}

/**
 * An agent asked for what the browser recorded. Collect it from the page recorder and POST it back
 * against the same requestId.
 *
 * Filtering happens here rather than on the server so only the entries the agent asked for ever
 * leave the browser: a full buffer is the user's page activity, and there is no reason to ship the
 * parts nobody requested. Every failure path still answers — the tool is waiting, and "unavailable"
 * with a reason is a better result for it than a timeout.
 */
async function answerBrowserRequest(sessionId, ev) {
  let body = { requestId: ev.requestId, dropped: 0 };
  try {
    const { tabId } = appStore.get();
    const captured = await getBrowserCapture(ev.kind, tabId);
    if (captured.unavailable) body.unavailable = captured.unavailable;
    else {
      const entries = trimCapture(ev.kind === 'network' ? captured.network : captured.console, ev);
      body = { ...body, [ev.kind]: entries, dropped: captured.dropped || 0 };
    }
  } catch (e) {
    body.unavailable = `Could not read the page: ${e.message}`;
  }
  try {
    await api.browserCapture(sessionId, body);
  } catch {
    // The tool will time out and say so; there is nothing useful to show the user here.
  }
}

/** Apply the request's since/filter/limit to a recorder buffer. */
function trimCapture(entries, ev) {
  let out = Array.isArray(entries) ? entries : [];
  if (ev.since) out = out.filter((e) => e.at >= ev.since);
  if (ev.filter) {
    const needle = ev.filter.toLowerCase();
    out = out.filter((e) => `${e.text || ''}${e.url || ''}`.toLowerCase().includes(needle));
  }
  // Keep the newest: on a wrapped buffer the recent entries are the ones being asked about.
  return out.slice(-Math.min(ev.limit || 50, 500));
}

export async function sendMessage(text) {
  const id = currentId;
  if (!id || !text.trim()) return;
  sessionStore.set({ sending: true });
  transcript.addLocalUser(text);
  transcript.status = 'running';
  publish();
  try {
    // Every message carries where the user is now, not just the first one: people navigate during
    // a session, and "the record I am looking at" is usually what the next prompt is about.
    await api.sendMessage(id, text, undefined, currentPageContextForApi());
  } catch (e) {
    transcript.status = sessionStore.get().session?.status || 'idle';
    publish({ error: e.message });
    throw e;
  } finally {
    if (currentId === id) sessionStore.set({ sending: false });
  }
}

export async function confirm(confirmationId, optionId, answerText) {
  const id = currentId;
  if (!id) return;
  await api.confirm(id, confirmationId, optionId, answerText);
  transcript.resolveConfirmation(confirmationId, optionId, true);
  if (optionId === 'approve_session') loadPermissions();
  publish();
  schedulePersist();
}

/** Dismiss the context-pressure banner until the server sends a fresh (usually worse) one. */
export function dismissContextPressure() {
  transcript?.clearContextPressure();
  sessionStore.set({ contextPressure: null });
}

/**
 * Ask the server to compact the conversation. The route is new; an older server answers 404, and
 * the honest fallback is to leave the message on screen rather than pretend something happened.
 */
export async function compact() {
  const id = currentId;
  if (!id) return { ok: false };
  try {
    await api.compact(id);
    dismissContextPressure();
    return { ok: true };
  } catch (e) {
    if (e.isNotFound) return { ok: false, unsupported: true };
    throw e;
  }
}

export async function cancel() {
  const id = currentId;
  if (!id) return;
  await api.cancel(id);
}

export async function resume() {
  const id = currentId;
  if (!id) return;
  sessionStore.set({ resuming: true, error: null });
  try {
    await api.resume(id);
    transcript.status = 'running';
    transcript.statusMessage = 'Resuming…';
    publish();
  } catch (e) {
    sessionStore.set({ error: e.message });
    throw e;
  } finally {
    if (currentId === id) sessionStore.set({ resuming: false });
  }
}

export async function feedback(helpful, note) {
  const id = currentId;
  if (!id) return;
  await api.feedback(id, helpful, note);
  sessionStore.set((s) => ({ session: s.session ? { ...s.session, helpful, feedbackNote: note || null } : s.session }));
  schedulePersist();
}

export async function createSession({ title } = {}) {
  const { org, uiMode } = appStore.get();
  if (!org) throw new Error('No org resolved for this tab');
  const body = { orgId: org.id, uiMode };
  if (title) body.title = title;
  const pc = currentPageContextForApi();
  if (pc && Object.keys(pc).length) body.pageContext = pc;
  const session = await api.createSession(body);
  return session.session || session;
}

export function clearError() {
  sessionStore.set({ error: null });
}

// When any request succeeds after being offline, pull a fresh snapshot to reconcile.
let resyncing = false;
apiEvents.on('online', () => {
  if (!currentId || !sessionStore.get().offline || resyncing) return;
  resyncing = true;
  resync().finally(() => {
    resyncing = false;
  });
});

/** Whether the current session can be resumed (failed/interrupted and not running). */
export function isResumable(state = sessionStore.get()) {
  const s = state.session;
  if (!s) return false;
  const status = state.status || s.status;
  if (status === 'running' || status === 'awaiting_confirmation') return false;
  const msg = String(state.statusMessage || '').toLowerCase();
  return status === 'failed' || msg.includes('resumable') || msg.includes('interrupted');
}
