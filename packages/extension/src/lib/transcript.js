/**
 * Reduces the SessionEvent stream into renderable transcript items. Pure JS, no DOM.
 * Items carry `kind` + booleans so LWC templates (no expressions) can branch on them.
 */
/**
 * Every SessionEvent type, listed rather than imported from @sf-claws/shared on purpose: the panel
 * does not bundle zod. `transcript.types.test.js` fails the build if this list and the schema drift
 * apart, which is what the SSE stream needs — the server names each event, so a type missing here
 * is simply never delivered.
 */
export const SESSION_EVENT_TYPES = [
  'model.started',
  'model.finished',
  'agent.spawned',
  'agent.finished',
  'assistant.delta',
  'assistant.message',
  'assistant.thinking',
  'tool.call',
  'tool.result',
  'workspace.file',
  'deploy.validation',
  'confirmation.requested',
  'confirmation.resolved',
  'deploy.result',
  'deploy.verified',
  'session.context',
  'github.commit',
  'doc.written',
  'session.status',
  'session.usage',
  'session.error',
  'user.message',
  'todo.updated',
  'note.written',
  'org.limits',
  'session.limit',
  'plan.submitted',
  'plan.resolved',
  'policy.blocked',
  // The panel answers this one rather than rendering it: without it registered, read_console_logs
  // and read_network_requests are asked for and never replied to.
  'browser.request',
  'session.page',
];

export function createTranscript() {
  const state = {
    items: [],
    byKey: new Map(),
    agents: new Map(), // agentId -> { agentId, role, modelId, objective, status, summary, parentAgentId }
    status: 'idle',
    statusMessage: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
    lastSeq: 0,
    seen: new Set(),
    lastError: null,
    todos: [], // TodoItem[] (latest todo.updated wins)
    todoAgentId: null,
    notes: [], // { noteId, agentId, role, title, tags, at } from note.written (content via /notes)
    limits: null, // OrgLimits from org.limits
    contextPressure: null, // session.context: latest context-window warning (banner, not a thread item)
    costLimit: null, // session.limit: a spend ceiling stopped the run
  };

  function push(item) {
    item.key = item.key || `${item.kind}-${state.items.length}-${item.seq ?? ''}`;
    state.items.push(item);
    state.byKey.set(item.key, item);
    return item;
  }

  /**
   * Replace an existing item with a shallow clone + patch. Items must be treated as immutable:
   * LWC only re-renders a child when the `item` reference changes.
   */
  function touch(item, patch) {
    const next = { ...item, ...patch };
    const i = state.items.indexOf(item);
    if (i >= 0) state.items[i] = next;
    else state.items.push(next);
    state.byKey.set(next.key, next);
    return next;
  }

  function apply(ev) {
    if (!ev || typeof ev !== 'object' || !ev.type) return false;
    if (typeof ev.seq === 'number') {
      if (state.seen.has(ev.seq)) return false;
      state.seen.add(ev.seq);
      if (ev.seq > state.lastSeq) state.lastSeq = ev.seq;
    }
    const at = ev.at;
    switch (ev.type) {
      case 'user.message': {
        // The echo of a message this panel sent replaces its optimistic copy rather than adding a
        // second bubble. Oldest first, so the same text sent twice still pairs up one-to-one.
        const local = state.items.find((i) => i.kind === 'user' && i.local && i.text === ev.text);
        const item = { kind: 'user', seq: ev.seq, at, text: ev.text, userId: ev.userId };
        if (local) touch(local, { ...item, local: false });
        else push(item);
        break;
      }
      case 'agent.spawned': {
        state.agents.set(ev.agentId, {
          agentId: ev.agentId,
          parentAgentId: ev.parentAgentId,
          role: ev.role,
          modelId: ev.modelId,
          objective: ev.objective,
          status: 'running',
          summary: '',
        });
        push({ kind: 'agent', seq: ev.seq, at, agentId: ev.agentId, role: ev.role, modelId: ev.modelId, objective: ev.objective, phase: 'spawned' });
        break;
      }
      case 'agent.finished': {
        const a = state.agents.get(ev.agentId);
        if (a) {
          a.status = ev.ok ? 'done' : 'failed';
          a.summary = ev.summary;
        } else state.agents.set(ev.agentId, { agentId: ev.agentId, role: ev.role, status: ev.ok ? 'done' : 'failed', summary: ev.summary, objective: '' });
        push({ kind: 'agent', seq: ev.seq, at, agentId: ev.agentId, role: ev.role, ok: ev.ok, summary: ev.summary, phase: 'finished' });
        break;
      }
      case 'assistant.delta': {
        const key = `msg-${ev.messageId}`;
        const item = state.byKey.get(key);
        if (!item)
          push({ kind: 'assistant', key, seq: ev.seq, at, agentId: ev.agentId, role: ev.role, messageId: ev.messageId, text: ev.delta || '', streaming: true });
        else touch(item, { text: item.text + (ev.delta || ''), streaming: true });
        break;
      }
      case 'assistant.message': {
        const key = `msg-${ev.messageId}`;
        const item = state.byKey.get(key);
        if (!item)
          push({ kind: 'assistant', key, seq: ev.seq, at, agentId: ev.agentId, role: ev.role, messageId: ev.messageId, text: ev.text ?? '', streaming: false });
        else touch(item, { text: ev.text ?? item.text, streaming: false });
        break;
      }
      case 'assistant.thinking': {
        // One event per streamed delta: append to the previous thinking row from the same agent.
        const last = state.items[state.items.length - 1];
        if (last && last.kind === 'thinking' && last.agentId === ev.agentId) touch(last, { text: (last.text || '') + (ev.text || '') });
        else push({ kind: 'thinking', seq: ev.seq, at, agentId: ev.agentId, role: ev.role, text: ev.text || '' });
        break;
      }
      case 'tool.call': {
        const key = `tool-${ev.toolCallId}`;
        const item = state.byKey.get(key);
        if (!item)
          push({
            kind: 'tool',
            key,
            seq: ev.seq,
            at,
            agentId: ev.agentId,
            role: ev.role,
            toolCallId: ev.toolCallId,
            tool: ev.tool,
            label: ev.label,
            input: ev.input,
            done: false,
            ok: null,
            output: undefined,
            durationMs: 0,
          });
        else touch(item, { tool: ev.tool, label: ev.label, input: ev.input });
        break;
      }
      case 'tool.result': {
        const key = `tool-${ev.toolCallId}`;
        const patch = { done: true, ok: ev.ok, output: ev.output, durationMs: ev.durationMs, resultLabel: ev.label };
        const item = state.byKey.get(key);
        if (!item)
          push({
            kind: 'tool',
            key,
            seq: ev.seq,
            at,
            agentId: ev.agentId,
            role: ev.role,
            toolCallId: ev.toolCallId,
            tool: ev.tool,
            label: ev.label,
            input: undefined,
            ...patch,
          });
        else touch(item, patch);
        break;
      }
      case 'workspace.file':
        push({ kind: 'workspace', seq: ev.seq, at, path: ev.path, action: ev.action, metadataType: ev.metadataType, fullName: ev.fullName });
        break;
      case 'deploy.validation':
        push({
          kind: 'validation',
          seq: ev.seq,
          at,
          ...pick(ev, ['deployId', 'scope', 'ok', 'attempt', 'componentsTotal', 'componentsFailed', 'testsTotal', 'testsFailed', 'codeCoverage', 'failures']),
        });
        break;
      case 'confirmation.requested': {
        const key = `confirm-${ev.confirmationId}`;
        if (!state.byKey.get(key))
          push({
            kind: 'confirmation',
            key,
            seq: ev.seq,
            at,
            ...pick(ev, ['confirmationId', 'title', 'description', 'impact', 'details', 'options', 'command']),
            confirmationKind: ev.kind,
            resolved: false,
            resolvedOptionId: null,
          });
        break;
      }
      case 'todo.updated':
        state.todos = Array.isArray(ev.items) ? ev.items.map((t) => ({ ...t })) : [];
        state.todoAgentId = ev.agentId || null;
        break;
      case 'note.written': {
        const note = { noteId: ev.noteId, agentId: ev.agentId, role: ev.role, title: ev.title, tags: ev.tags || [], at };
        const i = state.notes.findIndex((n) => n.noteId === ev.noteId);
        if (i >= 0) state.notes[i] = note;
        else state.notes.push(note);
        push({ kind: 'note', seq: ev.seq, at, ...note });
        break;
      }
      case 'org.limits':
        state.limits = ev.limits || null;
        break;
      case 'session.limit':
        // A ceiling stopped the run. Keep it visible: the session is resumable once it is raised.
        state.costLimit = { scope: ev.scope, limitUsd: ev.limitUsd, spentUsd: ev.spentUsd, message: ev.message };
        break;
      case 'policy.blocked':
        push({ kind: 'blocked', seq: ev.seq, at, agentId: ev.agentId, tool: ev.tool, rule: ev.rule, message: ev.message });
        break;
      case 'confirmation.resolved':
        resolveConfirmation(ev.confirmationId, ev.optionId);
        break;
      case 'deploy.result':
        push({ kind: 'deploy', seq: ev.seq, at, ...pick(ev, ['deployId', 'ok', 'sfDeployId', 'componentsDeployed', 'message']) });
        break;
      case 'deploy.verified':
        push({ kind: 'verified', seq: ev.seq, at, ...pick(ev, ['deployId', 'ok', 'components', 'summary']) });
        break;
      case 'session.context':
        // A banner, not a thread entry: it is a standing condition, and only the latest one matters.
        state.contextPressure = { level: ev.level, percent: ev.percent, message: ev.message, usedTokens: ev.usedTokens, limitTokens: ev.limitTokens, at };
        break;
      case 'github.commit':
        push({ kind: 'commit', seq: ev.seq, at, ...pick(ev, ['owner', 'repo', 'branch', 'sha', 'url', 'filesChanged', 'message', 'pullRequestUrl']) });
        break;
      case 'doc.written':
        push({ kind: 'doc', seq: ev.seq, at, ...pick(ev, ['docId', 'path', 'title']) });
        break;
      case 'session.status':
        state.status = ev.status;
        state.statusMessage = ev.message;
        for (const it of state.items.slice()) if (it.kind === 'assistant' && it.streaming) touch(it, { streaming: false });
        if (ev.status === 'running' || ev.status === 'awaiting_confirmation') break; // don't clutter the thread
        push({ kind: 'status', seq: ev.seq, at, status: ev.status, message: ev.message });
        break;
      case 'session.page':
        // Recorded for the audit trail, not the thread: the user knows they navigated.
        state.pageContext = ev.pageContext || null;
        break;
      case 'session.usage':
        state.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedInputTokens: ev.cachedInputTokens, costUsd: ev.costUsd };
        break;
      case 'session.error':
        state.lastError = ev.message;
        push({ kind: 'error', seq: ev.seq, at, agentId: ev.agentId, message: ev.message, recoverable: ev.recoverable });
        break;
      default:
        push({ kind: 'unknown', seq: ev.seq, at, type: ev.type, raw: ev });
    }
    return true;
  }

  function resolveConfirmation(confirmationId, optionId, local = false) {
    const item = state.byKey.get(`confirm-${confirmationId}`);
    if (!item) return null;
    return touch(item, {
      resolved: true,
      resolvedOptionId: optionId,
      resolvedLabel: item.options?.find((o) => o.id === optionId)?.label || optionId,
      localResolved: local,
    });
  }

  /** Seed unresolved confirmations from a snapshot/detail payload (shape: { id|confirmationId, kind, title, ...payload }). */
  function seedPending(list) {
    for (const c of list || []) {
      const confirmationId = c.confirmationId || c.id;
      if (!confirmationId) continue;
      const key = `confirm-${confirmationId}`;
      if (state.byKey.get(key)) continue;
      push({
        kind: 'confirmation',
        key,
        at: c.at || c.createdAt || new Date().toISOString(),
        confirmationId,
        confirmationKind: c.kind,
        title: c.title,
        description: c.description,
        impact: c.impact ?? null,
        details: c.details,
        options: c.options || [],
        command: c.command,
        resolved: false,
        resolvedOptionId: null,
      });
    }
  }

  return {
    apply,
    applyAll(list) {
      let n = 0;
      for (const e of list || []) if (apply(e)) n++;
      return n;
    },
    seedPending,
    resolveConfirmation,
    seedTodos(items) {
      if (Array.isArray(items) && !state.todos.length) state.todos = items.map((t) => ({ ...t }));
    },
    seedNotes(list) {
      for (const n of list || [])
        if (!state.notes.some((x) => x.noteId === n.id))
          state.notes.push({ noteId: n.id, agentId: n.agentId, role: n.role, title: n.title, tags: n.tags || [], at: n.updatedAt || n.createdAt });
    },
    /** Add a local (optimistic) user message before the server echoes user.message. */
    addLocalUser(text) {
      return push({ kind: 'user', at: new Date().toISOString(), text, local: true, key: `local-${Date.now()}` }).key;
    },
    /** Drop an optimistic user message the server never accepted (the POST failed). */
    removeLocalUser(key) {
      const item = state.byKey.get(key);
      if (!item?.local) return;
      state.items.splice(state.items.indexOf(item), 1);
      state.byKey.delete(key);
    },
    get items() {
      return state.items;
    },
    get agents() {
      return [...state.agents.values()];
    },
    get status() {
      return state.status;
    },
    set status(v) {
      state.status = v;
    },
    get statusMessage() {
      return state.statusMessage;
    },
    get usage() {
      return state.usage;
    },
    set usage(v) {
      state.usage = v;
    },
    get lastSeq() {
      return state.lastSeq;
    },
    set lastSeq(v) {
      state.lastSeq = Math.max(state.lastSeq, v || 0);
    },
    get pendingConfirmations() {
      return state.items.filter((i) => i.kind === 'confirmation' && !i.resolved);
    },
    get lastError() {
      return state.lastError;
    },
    get todos() {
      return state.todos;
    },
    get notes() {
      return state.notes;
    },
    get costLimit() {
      return state.costLimit;
    },
    get contextPressure() {
      return state.contextPressure;
    },
    clearContextPressure() {
      state.contextPressure = null;
    },
    get limits() {
      return state.limits;
    },
  };
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) o[k] = obj[k];
  return o;
}

/** Icon (emoji-free, short text) + tone by tool name. */
export function toolMeta(tool = '') {
  const t = String(tool).toLowerCase();
  if (t.includes('soql') || t.includes('query')) return { glyph: 'Q', tone: 'sky', title: 'Query' };
  if (t.includes('describe')) return { glyph: 'D', tone: 'sky', title: 'Describe' };
  if (t.includes('list_metadata') || t.includes('read_metadata') || t.includes('metadata')) return { glyph: 'M', tone: 'violet', title: 'Metadata' };
  if (t.includes('write') || t.includes('workspace')) return { glyph: 'W', tone: 'brand', title: 'Write file' };
  if (t.includes('validate') || t.includes('deploy')) return { glyph: 'V', tone: 'amber', title: 'Deploy' };
  if (t.includes('git') || t.includes('commit')) return { glyph: 'G', tone: 'emerald', title: 'GitHub' };
  if (t.includes('log') || t.includes('debug')) return { glyph: 'L', tone: 'rose', title: 'Logs' };
  if (t.includes('doc')) return { glyph: 'T', tone: 'teal', title: 'Docs' };
  if (t.includes('skill') || t.includes('memory') || t.includes('search')) return { glyph: 'S', tone: 'slate', title: 'Knowledge' };
  return { glyph: '•', tone: 'slate', title: 'Step' };
}

/**
 * True once the latest user message has a finished assistant reply after it. `idle` alone is not
 * enough: a new session is idle with a "Session created" status item and nothing said yet.
 */
export function turnAnswered(items = []) {
  let lastUser = -1;
  let lastReply = -1;
  items.forEach((it, i) => {
    if (it.kind === 'user') lastUser = i;
    else if (it.kind === 'assistant' && !it.streaming) lastReply = i;
  });
  return lastReply > lastUser;
}
