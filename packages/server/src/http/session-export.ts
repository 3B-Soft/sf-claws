import JSZip from 'jszip';
import type { AppContext } from '../app-context.js';
import { auditData } from '../lib/audit-data.js';

const json = (value: unknown) => JSON.stringify(value, null, 2);
const safePath = (path: string) => !/^[\\/]|^[a-z]:/i.test(path) && !path.split(/[\\/]/).some((p) => p === '..' || p === '.') && !path.includes('\0');

/** Source snapshot for investigation, with deletions recorded rather than turned into empty source files. */
export function workspaceArchive(ctx: AppContext, sessionId: string): JSZip {
  const zip = new JSZip();
  const files = ctx.repos.workspace.list(sessionId);
  zip.file(
    'workspace.json',
    json({
      sessionId,
      exportedAt: new Date().toISOString(),
      files,
      note: 'Investigation snapshot of staged source and originals. This is not a validated deployment package.',
    }),
  );
  for (const file of files) {
    if (!safePath(file.path)) throw new Error(`Unsafe workspace path: ${file.path}`);
    if (file.action !== 'deleted') zip.file(`source/${file.path}`, file.content);
    if (file.original != null) zip.file(`originals/${file.path}`, file.original);
  }
  return zip;
}

/** Snapshot all retained evidence synchronously before ZIP generation yields to other requests. */
export function auditArchive(ctx: AppContext, sessionId: string): JSZip {
  const zip = workspaceArchive(ctx, sessionId);
  const throughSeq = ctx.repos.events.lastSeq(sessionId);
  const events = [];
  let after = 0;
  for (;;) {
    const page = ctx.repos.events.listAfter(sessionId, after, 500, throughSeq);
    if (!page.length) break;
    events.push(...page);
    after = page[page.length - 1].seq;
  }
  const checkpoints = ctx.repos.harness.list(sessionId, Number.MAX_SAFE_INTEGER).map((checkpoint) => ({
    checkpoint,
    attempts: ctx.repos.harness.attempts(sessionId, checkpoint.id),
  }));
  const agentState = ctx.repos.agentState.get(sessionId);
  const agentIds = new Set([
    'orchestrator',
    ...agentState.workers.map((w) => w.id),
    ...events.flatMap((e) => ('agentId' in e && e.agentId ? [e.agentId] : [])),
  ]);
  const conversations = [...agentIds].map((agentId) => ({ agentId, messages: ctx.repos.messages.list(sessionId, agentId) }));
  zip.file(
    'manifest.json',
    json({
      version: 1,
      sessionId,
      throughSeq,
      exportedAt: new Date().toISOString(),
      limitations: [
        'Includes retained observable messages, decisions, tool calls, worker reports, and validation evidence; excludes private model reasoning and provider raw blocks.',
        'Historical ephemeral thinking/deltas, truncated tool inputs, and pre-compaction conversations cannot be reconstructed. New audit records preserve visible messages and full tool evidence.',
        'Original Salesforce terminal responses are available only for attempts recorded after raw-response capture was added.',
      ],
    }),
  );
  zip.file('events.ndjson', events.map((e) => JSON.stringify(auditData(e))).join('\n') + '\n');
  for (const [name, value] of Object.entries({
    session: ctx.repos.sessions.byId(sessionId),
    agents: agentState,
    conversations,
    validations: checkpoints,
    deploys: ctx.repos.deploys.list(sessionId),
    compileControl: ctx.repos.compileControl.get(sessionId),
    todos: ctx.repos.todos.get(sessionId),
    notes: ctx.repos.notes.list(sessionId),
    docs: ctx.repos.docs.bySession(sessionId),
    audit: ctx.repos.audit.forTarget(sessionId),
    artifacts: ctx.repos.artifacts.list(sessionId).map((a) => ctx.repos.artifacts.forSession(sessionId, a.id)),
  }))
    zip.file(`${name}.json`, json(auditData(value)));
  return zip;
}
