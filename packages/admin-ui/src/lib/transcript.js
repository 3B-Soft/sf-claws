/**
 * Reduce a SessionEvent[] into a render model for the transcript:
 * blocks (ordered), agents (swarm), usage, status, pending confirmations.
 * Blocks: { id, kind: 'message'|'thinking'|'tool'|'validation'|'confirmation'|'deploy'|'commit'|'doc'|'status'|'error'|'user'|'workspace'|'agent'|'note'|'blocked'|'limits', ... }
 * Also returns: todos (latest full list), notes (metadata only), limits (latest OrgLimits), blocked (policy refusals).
 */
export function buildTranscript(events = []) {
  const blocks = [];
  const byId = new Map();
  const agents = new Map();
  const confirmations = new Map();
  let usage = null;
  let status = null;
  let statusMessage = null;
  let lastSeq = 0;
  let todos = null;
  let limits = null;
  const notes = new Map();
  const blocked = [];

  const push = (b) => {
    blocks.push(b);
    byId.set(b.id, b);
    return b;
  };

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.seq === 'number') lastSeq = Math.max(lastSeq, ev.seq);
    switch (ev.type) {
      case 'agent.spawned': {
        agents.set(ev.agentId, {
          agentId: ev.agentId,
          parentAgentId: ev.parentAgentId,
          role: ev.role,
          modelId: ev.modelId,
          objective: ev.objective,
          status: 'running',
          startedAt: ev.at,
          summary: null,
          ok: null,
        });
        push({
          id: `agent-${ev.seq}`,
          kind: 'agent',
          agentId: ev.agentId,
          role: ev.role,
          modelId: ev.modelId,
          objective: ev.objective,
          at: ev.at,
          phase: 'spawned',
        });
        break;
      }
      case 'agent.finished': {
        const a = agents.get(ev.agentId);
        if (a) {
          a.status = ev.ok ? 'finished' : 'failed';
          a.ok = ev.ok;
          a.summary = ev.summary;
          a.finishedAt = ev.at;
        } else
          agents.set(ev.agentId, {
            agentId: ev.agentId,
            parentAgentId: null,
            role: ev.role,
            modelId: '',
            objective: '',
            status: ev.ok ? 'finished' : 'failed',
            ok: ev.ok,
            summary: ev.summary,
            finishedAt: ev.at,
          });
        push({ id: `agentf-${ev.seq}`, kind: 'agent', agentId: ev.agentId, role: ev.role, ok: ev.ok, summary: ev.summary, at: ev.at, phase: 'finished' });
        break;
      }
      case 'assistant.delta': {
        const id = `msg-${ev.messageId}`;
        const b = byId.get(id);
        if (b) {
          b.text += ev.delta;
          b.streaming = true;
          b.at = ev.at;
        } else push({ id, kind: 'message', agentId: ev.agentId, role: ev.role, messageId: ev.messageId, text: ev.delta, streaming: true, at: ev.at });
        break;
      }
      case 'assistant.message': {
        const id = `msg-${ev.messageId}`;
        const b = byId.get(id);
        if (b) {
          b.text = ev.text;
          b.streaming = false;
        } else push({ id, kind: 'message', agentId: ev.agentId, role: ev.role, messageId: ev.messageId, text: ev.text, streaming: false, at: ev.at });
        break;
      }
      case 'assistant.thinking':
        push({ id: `think-${ev.seq}`, kind: 'thinking', agentId: ev.agentId, role: ev.role, text: ev.text, at: ev.at });
        break;
      case 'tool.call':
        push({
          id: `tool-${ev.toolCallId}`,
          kind: 'tool',
          agentId: ev.agentId,
          role: ev.role,
          toolCallId: ev.toolCallId,
          tool: ev.tool,
          label: ev.label,
          input: ev.input,
          ok: null,
          output: undefined,
          durationMs: null,
          resultLabel: null,
          at: ev.at,
          pending: true,
        });
        break;
      case 'tool.result': {
        const id = `tool-${ev.toolCallId}`;
        const b = byId.get(id);
        if (b) {
          b.ok = ev.ok;
          b.output = ev.output;
          b.durationMs = ev.durationMs;
          b.resultLabel = ev.label;
          b.pending = false;
        } else
          push({
            id,
            kind: 'tool',
            agentId: ev.agentId,
            role: ev.role,
            toolCallId: ev.toolCallId,
            tool: ev.tool,
            label: ev.label,
            input: undefined,
            ok: ev.ok,
            output: ev.output,
            durationMs: ev.durationMs,
            resultLabel: ev.label,
            at: ev.at,
            pending: false,
          });
        break;
      }
      case 'workspace.file':
        push({ id: `ws-${ev.seq}`, kind: 'workspace', path: ev.path, action: ev.action, metadataType: ev.metadataType, fullName: ev.fullName, at: ev.at });
        break;
      case 'deploy.validation':
        push({ id: `val-${ev.seq}`, kind: 'validation', validation: ev, at: ev.at });
        break;
      case 'confirmation.requested': {
        const b = push({ id: `conf-${ev.confirmationId}`, kind: 'confirmation', confirmation: ev, resolved: false, optionId: null, at: ev.at });
        confirmations.set(ev.confirmationId, b);
        break;
      }
      case 'confirmation.resolved': {
        const b = confirmations.get(ev.confirmationId);
        if (b) {
          b.resolved = true;
          b.optionId = ev.optionId;
          b.byUserId = ev.byUserId;
        }
        break;
      }
      case 'deploy.result':
        push({ id: `dep-${ev.seq}`, kind: 'deploy', result: ev, at: ev.at });
        break;
      case 'github.commit':
        push({ id: `git-${ev.seq}`, kind: 'commit', commit: ev, at: ev.at });
        break;
      case 'doc.written':
        push({ id: `doc-${ev.seq}`, kind: 'doc', doc: ev, at: ev.at });
        break;
      case 'todo.updated':
        todos = { agentId: ev.agentId, items: ev.items || [], at: ev.at };
        break;
      case 'note.written':
        notes.set(ev.noteId, { noteId: ev.noteId, agentId: ev.agentId, role: ev.role, title: ev.title, tags: ev.tags || [], at: ev.at });
        push({ id: `note-${ev.seq}`, kind: 'note', noteId: ev.noteId, agentId: ev.agentId, role: ev.role, title: ev.title, tags: ev.tags || [], at: ev.at });
        break;
      case 'org.limits':
        limits = ev.limits;
        push({ id: `limits-${ev.seq}`, kind: 'limits', limits: ev.limits, at: ev.at });
        break;
      case 'policy.blocked':
        blocked.push({ tool: ev.tool, rule: ev.rule, message: ev.message, at: ev.at });
        push({ id: `blocked-${ev.seq}`, kind: 'blocked', agentId: ev.agentId, tool: ev.tool, rule: ev.rule, message: ev.message, at: ev.at });
        break;
      case 'session.status':
        status = ev.status;
        statusMessage = ev.message ?? null;
        push({ id: `status-${ev.seq}`, kind: 'status', status: ev.status, message: ev.message, at: ev.at });
        break;
      case 'session.usage':
        usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedInputTokens: ev.cachedInputTokens, costUsd: ev.costUsd };
        break;
      case 'session.error':
        push({ id: `err-${ev.seq}`, kind: 'error', message: ev.message, recoverable: ev.recoverable, agentId: ev.agentId, at: ev.at });
        break;
      case 'user.message':
        push({ id: `user-${ev.seq}`, kind: 'user', text: ev.text, userId: ev.userId, at: ev.at });
        break;
      default:
        push({ id: `raw-${ev.seq ?? blocks.length}`, kind: 'raw', event: ev, at: ev.at });
    }
  }

  return {
    blocks,
    agents: [...agents.values()],
    usage,
    status,
    statusMessage,
    lastSeq,
    todos,
    notes: [...notes.values()],
    limits,
    blocked,
    pendingConfirmations: [...confirmations.values()].filter((c) => !c.resolved),
  };
}
