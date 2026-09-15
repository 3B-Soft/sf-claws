import type {
  Session,
  SessionStatus,
  SessionEvent,
  UiMode,
  UsageRecord,
  DocEntry,
  DeployRun,
  WorkspaceFile,
  AgentRole,
  TodoItem,
  Note,
  OrgLimits,
} from '@sf-claws/shared';
import { type Db, nowIso, rowToObj } from '../db.js';
import { newId } from '../../lib/crypto.js';

export interface SessionRow extends Session {
  pageContext: unknown;
  branchName: string | null;
}
const toSession = (r: any) => rowToObj<SessionRow>(r, { bools: ['helpful'], json: ['pageContext'] });

export class SessionsRepo {
  constructor(private db: Db) {}
  byId(id: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return r ? toSession(r) : undefined;
  }
  list(
    filter: { userId?: string; clientId?: string; orgId?: string; status?: SessionStatus; helpful?: boolean; from?: string; to?: string; limit?: number } = {},
  ): SessionRow[] {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (filter.userId) {
      where.push('user_id=?');
      vals.push(filter.userId);
    }
    if (filter.clientId) {
      where.push('client_id=?');
      vals.push(filter.clientId);
    }
    if (filter.orgId) {
      where.push('org_id=?');
      vals.push(filter.orgId);
    }
    if (filter.status) {
      where.push('status=?');
      vals.push(filter.status);
    }
    if (filter.helpful !== undefined) {
      where.push('helpful=?');
      vals.push(filter.helpful ? 1 : 0);
    }
    if (filter.from) {
      where.push('created_at>=?');
      vals.push(filter.from);
    }
    if (filter.to) {
      where.push('created_at<=?');
      vals.push(filter.to);
    }
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...vals, filter.limit ?? 200)
      .map(toSession);
  }
  create(input: {
    userId: string;
    clientId: string;
    orgId: string;
    projectId?: string | null;
    taskId?: string | null;
    title: string;
    uiMode: UiMode;
    pageContext?: unknown;
  }): SessionRow {
    const id = newId('ses');
    const now = nowIso();
    this.db
      .prepare(`INSERT INTO sessions (id, user_id, client_id, org_id, project_id, task_id, title, status, ui_mode, page_context, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`)
      .run(
        id,
        input.userId,
        input.clientId,
        input.orgId,
        input.projectId ?? null,
        input.taskId ?? null,
        input.title,
        input.uiMode,
        input.pageContext ? JSON.stringify(input.pageContext) : null,
        now,
        now,
      );
    return this.byId(id)!;
  }
  update(
    id: string,
    patch: Partial<{
      title: string;
      status: SessionStatus;
      helpful: boolean | null;
      feedbackNote: string | null;
      completedAt: string | null;
      branchName: string | null;
      projectId: string | null;
      taskId: string | null;
      planMarkdown: string | null;
      planApprovedAt: string | null;
      planRevision: number;
      pageContext: unknown;
    }>,
  ): SessionRow | undefined {
    const map: Record<string, string> = {
      title: 'title',
      status: 'status',
      helpful: 'helpful',
      feedbackNote: 'feedback_note',
      completedAt: 'completed_at',
      branchName: 'branch_name',
      projectId: 'project_id',
      taskId: 'task_id',
      planMarkdown: 'plan_markdown',
      planApprovedAt: 'plan_approved_at',
      planRevision: 'plan_revision',
      pageContext: 'page_context',
    };
    const sets: string[] = ['updated_at=?'];
    const vals: unknown[] = [nowIso()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(k === 'pageContext' ? (v === null ? null : JSON.stringify(v)) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }
  addUsage(id: string, u: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number }): void {
    this.db
      .prepare(
        'UPDATE sessions SET input_tokens=input_tokens+?, output_tokens=output_tokens+?, cached_input_tokens=cached_input_tokens+?, cost_usd=cost_usd+?, updated_at=? WHERE id=?',
      )
      .run(u.inputTokens, u.outputTokens, u.cachedInputTokens, u.costUsd, nowIso(), id);
  }
  countSince(iso: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM sessions WHERE created_at>=?').get(iso) as any).c;
  }
}

export class EventsRepo {
  constructor(private db: Db) {}
  lastSeq(sessionId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM session_events WHERE session_id=?').get(sessionId) as any).s;
  }
  append(sessionId: string, seq: number, ev: SessionEvent): void {
    this.db
      .prepare('INSERT INTO session_events (session_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, seq, ev.type, ev.at, JSON.stringify(ev));
  }
  hasType(sessionId: string, type: SessionEvent['type']): boolean {
    return !!this.db.prepare('SELECT 1 FROM session_events WHERE session_id=? AND type=? LIMIT 1').get(sessionId, type);
  }
  listAfter(sessionId: string, after = 0, limit = 5000): SessionEvent[] {
    return this.db
      .prepare('SELECT payload FROM session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(sessionId, after, limit)
      .map((r: any) => JSON.parse(r.payload));
  }
}

export interface StoredMessage {
  id: string;
  agentId: string;
  role: string;
  content: unknown;
  createdAt: string;
}
export class MessagesRepo {
  constructor(private db: Db) {}
  append(sessionId: string, agentId: string, role: string, content: unknown): void {
    this.db
      .prepare('INSERT INTO session_messages (id, session_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId('msg'), sessionId, agentId, role, JSON.stringify(content), nowIso());
  }
  list(sessionId: string, agentId: string): StoredMessage[] {
    return this.db
      .prepare('SELECT id, agent_id, role, content, created_at FROM session_messages WHERE session_id=? AND agent_id=? ORDER BY created_at, rowid')
      .all(sessionId, agentId)
      .map((r) => rowToObj<StoredMessage>(r, { json: ['content'] }));
  }
  replace(sessionId: string, agentId: string, messages: { role: string; content: unknown }[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_messages WHERE session_id=? AND agent_id=?').run(sessionId, agentId);
      for (const m of messages) this.append(sessionId, agentId, m.role, m.content);
    });
    tx();
  }
}

export class WorkspaceRepo {
  constructor(private db: Db) {}
  list(sessionId: string): WorkspaceFile[] {
    return this.db
      .prepare('SELECT path, content, original, metadata_type, full_name, action FROM workspace_files WHERE session_id=? ORDER BY path')
      .all(sessionId)
      .map((r) => rowToObj<WorkspaceFile>(r));
  }
  get(sessionId: string, path: string): WorkspaceFile | undefined {
    return rowToObj<WorkspaceFile>(
      this.db
        .prepare('SELECT path, content, original, metadata_type, full_name, action FROM workspace_files WHERE session_id=? AND path=?')
        .get(sessionId, path),
    );
  }
  upsert(sessionId: string, f: WorkspaceFile): void {
    this.db
      .prepare(`INSERT INTO workspace_files (session_id, path, content, original, metadata_type, full_name, action, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, path) DO UPDATE SET content=excluded.content, original=COALESCE(workspace_files.original, excluded.original), metadata_type=excluded.metadata_type, full_name=excluded.full_name, action=CASE WHEN workspace_files.action='created' AND excluded.action='modified' THEN 'created' ELSE excluded.action END, updated_at=excluded.updated_at`)
      .run(sessionId, f.path, f.content, f.original ?? null, f.metadataType, f.fullName, f.action, nowIso());
  }
  remove(sessionId: string, path: string): void {
    this.db.prepare('DELETE FROM workspace_files WHERE session_id=? AND path=?').run(sessionId, path);
  }
}

const toDeploy = (r: any) => rowToObj<DeployRun>(r, { bools: ['checkOnly'], json: ['failures'] });
export class DeploysRepo {
  constructor(private db: Db) {}
  list(sessionId: string): DeployRun[] {
    return this.db.prepare('SELECT * FROM deploy_runs WHERE session_id=? ORDER BY created_at').all(sessionId).map(toDeploy);
  }
  byId(id: string): DeployRun | undefined {
    const r = this.db.prepare('SELECT * FROM deploy_runs WHERE id=?').get(id);
    return r ? toDeploy(r) : undefined;
  }
  latest(sessionId: string, checkOnly?: boolean): DeployRun | undefined {
    const r =
      checkOnly === undefined
        ? this.db.prepare('SELECT * FROM deploy_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId)
        : this.db.prepare('SELECT * FROM deploy_runs WHERE session_id=? AND check_only=? ORDER BY created_at DESC LIMIT 1').get(sessionId, checkOnly ? 1 : 0);
    return r ? toDeploy(r) : undefined;
  }
  nextAttempt(sessionId: string): number {
    return ((this.db.prepare('SELECT COALESCE(MAX(attempt),0) a FROM deploy_runs WHERE session_id=?').get(sessionId) as any).a as number) + 1;
  }
  create(input: { sessionId: string; orgId: string; checkOnly: boolean; testLevel: DeployRun['testLevel']; attempt: number }): DeployRun {
    const id = newId('dep');
    this.db
      .prepare(`INSERT INTO deploy_runs (id, session_id, org_id, check_only, status, attempt, test_level, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(id, input.sessionId, input.orgId, input.checkOnly ? 1 : 0, input.attempt, input.testLevel, nowIso());
    return this.byId(id)!;
  }
  update(id: string, patch: Partial<Omit<DeployRun, 'id' | 'sessionId' | 'orgId' | 'checkOnly' | 'attempt' | 'createdAt'>>): DeployRun | undefined {
    const map: Record<string, string> = {
      status: 'status',
      sfDeployId: 'sf_deploy_id',
      componentsTotal: 'components_total',
      componentsFailed: 'components_failed',
      testsTotal: 'tests_total',
      testsFailed: 'tests_failed',
      codeCoverage: 'code_coverage',
      failures: 'failures',
      testLevel: 'test_level',
      completedAt: 'completed_at',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(k === 'failures' ? JSON.stringify(v) : v);
    }
    if (sets.length) this.db.prepare(`UPDATE deploy_runs SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }
}

export interface ConfirmationRow {
  id: string;
  sessionId: string;
  kind: string;
  title: string;
  payload: any;
  resolvedOption: string | null;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export class ConfirmationsRepo {
  constructor(private db: Db) {}
  create(input: { sessionId: string; kind: string; title: string; payload: unknown }): ConfirmationRow {
    const id = newId('cfm');
    this.db
      .prepare('INSERT INTO confirmations (id, session_id, kind, title, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.sessionId, input.kind, input.title, JSON.stringify(input.payload), nowIso());
    return this.byId(id)!;
  }
  byId(id: string): ConfirmationRow | undefined {
    return rowToObj<ConfirmationRow>(this.db.prepare('SELECT * FROM confirmations WHERE id=?').get(id), { json: ['payload'] });
  }
  pending(sessionId: string): ConfirmationRow[] {
    return this.db
      .prepare('SELECT * FROM confirmations WHERE session_id=? AND resolved_at IS NULL ORDER BY created_at')
      .all(sessionId)
      .map((r) => rowToObj<ConfirmationRow>(r, { json: ['payload'] }));
  }
  resolve(id: string, optionId: string, userId: string, answerText?: string | null): void {
    // The free-text answer rides in the payload: ask_user lets the user type instead of picking.
    const row = this.byId(id);
    const payload = answerText ? JSON.stringify({ ...((row?.payload as object) ?? {}), answerText }) : null;
    if (payload)
      this.db
        .prepare('UPDATE confirmations SET resolved_option=?, resolved_by=?, resolved_at=?, payload=? WHERE id=?')
        .run(optionId, userId, nowIso(), payload, id);
    else this.db.prepare('UPDATE confirmations SET resolved_option=?, resolved_by=?, resolved_at=? WHERE id=?').run(optionId, userId, nowIso(), id);
  }
}

export class UsageRepo {
  constructor(private db: Db) {}
  add(rec: Omit<UsageRecord, 'id' | 'createdAt'>): UsageRecord {
    const id = newId('use');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO usage_records (id, session_id, user_id, client_id, role, provider, model_id, input_tokens, output_tokens, cached_input_tokens, cost_usd, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        rec.sessionId,
        rec.userId,
        rec.clientId,
        rec.role,
        rec.provider,
        rec.modelId,
        rec.inputTokens,
        rec.outputTokens,
        rec.cachedInputTokens,
        rec.costUsd,
        rec.durationMs,
        now,
      );
    return { ...rec, id, createdAt: now };
  }
  bySession(sessionId: string): UsageRecord[] {
    return this.db
      .prepare('SELECT * FROM usage_records WHERE session_id=? ORDER BY created_at')
      .all(sessionId)
      .map((r) => rowToObj<UsageRecord>(r));
  }
  summary(
    groupBy: 'user' | 'client' | 'model' | 'role',
    from: string,
    to: string,
  ): { key: string; sessions: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number }[] {
    const col = { user: 'user_id', client: 'client_id', model: 'model_id', role: 'role' }[groupBy];
    return this.db
      .prepare(`SELECT ${col} AS key, COUNT(DISTINCT session_id) sessions, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(cached_input_tokens) cached_input_tokens, SUM(cost_usd) cost_usd
      FROM usage_records WHERE created_at>=? AND created_at<=? GROUP BY ${col} ORDER BY cost_usd DESC`)
      .all(from, to)
      .map((r) => rowToObj(r));
  }
  costSince(iso: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM usage_records WHERE created_at>=?').get(iso) as any).c;
  }
  /** Spend for one client since an instant — the client-month ceiling reads this. */
  clientCostSince(clientId: string, iso: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM usage_records WHERE client_id=? AND created_at>=?').get(clientId, iso) as any).c;
  }
  /** Per-tool call counts, failures and durations for a session (super-admin observability). */
  toolStats(sessionId: string): { tool: string; calls: number; failures: number; totalMs: number; maxMs: number }[] {
    return this.db
      .prepare(`SELECT tool, COUNT(*) calls, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) failures, SUM(duration_ms) total_ms, MAX(duration_ms) max_ms
      FROM tool_invocations WHERE session_id=? GROUP BY tool ORDER BY calls DESC`)
      .all(sessionId)
      .map((r) => rowToObj(r));
  }
  /** Fleet-wide per-tool rollup over a window. */
  toolSummary(from: string, to: string): { tool: string; calls: number; failures: number; totalMs: number; avgResultChars: number }[] {
    return this.db
      .prepare(`SELECT tool, COUNT(*) calls, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) failures, SUM(duration_ms) total_ms, CAST(AVG(result_chars) AS INTEGER) avg_result_chars
      FROM tool_invocations WHERE created_at>=? AND created_at<=? GROUP BY tool ORDER BY calls DESC`)
      .all(from, to)
      .map((r) => rowToObj(r));
  }
  addToolInvocation(rec: {
    sessionId: string;
    agentId: string;
    role: string;
    tool: string;
    ok: boolean;
    durationMs: number;
    resultChars: number;
    clientId: string;
    userId: string;
  }): void {
    this.db
      .prepare(`INSERT INTO tool_invocations (id, session_id, agent_id, role, tool, ok, duration_ms, result_chars, client_id, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId('tin'), rec.sessionId, rec.agentId, rec.role, rec.tool, rec.ok ? 1 : 0, rec.durationMs, rec.resultChars, rec.clientId, rec.userId, nowIso());
  }
}

const toDoc = (r: any) => rowToObj<DocEntry>(r, { json: ['tags'] });
export class DocsRepo {
  constructor(private db: Db) {}
  create(input: Omit<DocEntry, 'id' | 'createdAt'>): DocEntry {
    const id = newId('doc');
    this.db
      .prepare(
        'INSERT INTO docs (id, session_id, client_id, org_id, path, title, markdown, summary, tags, committed_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.sessionId,
        input.clientId,
        input.orgId,
        input.path,
        input.title,
        input.markdown,
        input.summary,
        JSON.stringify(input.tags ?? []),
        input.committedSha ?? null,
        nowIso(),
      );
    return this.byId(id)!;
  }
  byId(id: string): DocEntry | undefined {
    const r = this.db.prepare('SELECT * FROM docs WHERE id=?').get(id);
    return r ? toDoc(r) : undefined;
  }
  bySession(sessionId: string): DocEntry[] {
    return this.db.prepare('SELECT * FROM docs WHERE session_id=? ORDER BY created_at').all(sessionId).map(toDoc);
  }
  byOrg(orgId: string, limit = 50): DocEntry[] {
    return this.db.prepare('SELECT * FROM docs WHERE org_id=? ORDER BY created_at DESC LIMIT ?').all(orgId, limit).map(toDoc);
  }
  byClient(clientId: string, limit = 50): DocEntry[] {
    return this.db.prepare('SELECT * FROM docs WHERE client_id=? ORDER BY created_at DESC LIMIT ?').all(clientId, limit).map(toDoc);
  }
  setCommitted(id: string, sha: string): void {
    this.db.prepare('UPDATE docs SET committed_sha=? WHERE id=?').run(sha, id);
  }
  /** Full text search across an org's documentation (persistent memory retrieval). */
  search(orgId: string, query: string, limit = 8): DocEntry[] {
    const terms = query
      .replace(/[^\p{L}\p{N}_ ]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 12);
    if (!terms.length) return this.byOrg(orgId, limit);
    const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    try {
      return this.db
        .prepare(`SELECT d.* FROM docs_fts f JOIN docs d ON d.rowid=f.rowid WHERE docs_fts MATCH ? AND d.org_id=? ORDER BY bm25(docs_fts) LIMIT ?`)
        .all(match, orgId, limit)
        .map(toDoc);
    } catch {
      return this.byOrg(orgId, limit);
    }
  }
}

export class TodosRepo {
  constructor(private db: Db) {}
  get(sessionId: string): TodoItem[] {
    const r = this.db.prepare('SELECT items FROM session_todos WHERE session_id=?').get(sessionId) as any;
    return r ? JSON.parse(r.items) : [];
  }
  set(sessionId: string, items: TodoItem[], agentId: string): void {
    this.db
      .prepare(`INSERT INTO session_todos (session_id, items, updated_at, updated_by_agent) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET items=excluded.items, updated_at=excluded.updated_at, updated_by_agent=excluded.updated_by_agent`)
      .run(sessionId, JSON.stringify(items), nowIso(), agentId);
  }
}

const toNote = (r: any) => rowToObj<Note>(r, { json: ['tags'] });
export class NotesRepo {
  constructor(private db: Db) {}
  list(sessionId: string): Note[] {
    return this.db.prepare('SELECT * FROM session_notes WHERE session_id=? ORDER BY updated_at').all(sessionId).map(toNote);
  }
  byId(id: string): Note | undefined {
    const r = this.db.prepare('SELECT * FROM session_notes WHERE id=?').get(id);
    return r ? toNote(r) : undefined;
  }
  byTitle(sessionId: string, title: string): Note | undefined {
    const r = this.db.prepare('SELECT * FROM session_notes WHERE session_id=? AND title=?').get(sessionId, title);
    return r ? toNote(r) : undefined;
  }
  upsert(input: { sessionId: string; agentId: string; role: AgentRole; title: string; content: string; tags: string[] }): Note {
    const existing = this.byTitle(input.sessionId, input.title);
    const now = nowIso();
    if (existing) {
      this.db
        .prepare('UPDATE session_notes SET content=?, tags=?, agent_id=?, role=?, updated_at=? WHERE id=?')
        .run(input.content, JSON.stringify(input.tags), input.agentId, input.role, now, existing.id);
      return this.byId(existing.id)!;
    }
    const id = newId('note');
    this.db
      .prepare('INSERT INTO session_notes (id, session_id, agent_id, role, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.sessionId, input.agentId, input.role, input.title, input.content, JSON.stringify(input.tags), now, now);
    return this.byId(id)!;
  }
}

export class PermissionsRepo {
  constructor(private db: Db) {}
  list(sessionId: string): { command: string; grantedBy: string; grantedAt: string }[] {
    return this.db
      .prepare('SELECT command, granted_by, granted_at FROM session_permissions WHERE session_id=?')
      .all(sessionId)
      .map((r) => rowToObj(r));
  }
  has(sessionId: string, command: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM session_permissions WHERE session_id=? AND command=?').get(sessionId, command);
  }
  grant(sessionId: string, command: string, userId: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO session_permissions (session_id, command, granted_by, granted_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, command, userId, nowIso());
  }
  revoke(sessionId: string, command: string): void {
    this.db.prepare('DELETE FROM session_permissions WHERE session_id=? AND command=?').run(sessionId, command);
  }
}

export class LimitsRepo {
  constructor(private db: Db) {}
  get(orgId: string): OrgLimits | undefined {
    const r = this.db.prepare('SELECT snapshot FROM org_limits WHERE org_id=?').get(orgId) as any;
    return r ? JSON.parse(r.snapshot) : undefined;
  }
  set(orgId: string, snapshot: OrgLimits): void {
    this.db
      .prepare(
        'INSERT INTO org_limits (org_id, snapshot, fetched_at) VALUES (?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET snapshot=excluded.snapshot, fetched_at=excluded.fetched_at',
      )
      .run(orgId, JSON.stringify(snapshot), snapshot.fetchedAt);
  }
}

export interface ToolArtifact {
  id: string;
  sessionId: string;
  tool: string;
  label: string;
  content: string;
  bytes: number;
  createdAt: string;
}
/**
 * Oversized tool output, kept out of the model's context but retrievable by handle.
 * See `read_tool_output` in agents/tools.ts.
 */
export class ArtifactsRepo {
  constructor(private db: Db) {}
  /** Total artifact bytes already stored for a session — the spill path checks this before writing. */
  bytesForSession(sessionId: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(bytes),0) b FROM tool_artifacts WHERE session_id=?').get(sessionId) as { b: number }).b;
  }
  create(input: { sessionId: string; tool: string; label: string; content: string }): ToolArtifact {
    const id = newId('art');
    this.db
      .prepare('INSERT INTO tool_artifacts (id, session_id, tool, label, content, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.sessionId, input.tool, input.label, input.content, Buffer.byteLength(input.content, 'utf8'), nowIso());
    return this.byId(id)!;
  }
  byId(id: string): ToolArtifact | undefined {
    return rowToObj<ToolArtifact>(this.db.prepare('SELECT * FROM tool_artifacts WHERE id=?').get(id));
  }
  /** Scoped read: an artifact is only reachable from the session that produced it. */
  forSession(sessionId: string, id: string): ToolArtifact | undefined {
    return rowToObj<ToolArtifact>(this.db.prepare('SELECT * FROM tool_artifacts WHERE id=? AND session_id=?').get(id, sessionId));
  }
  list(sessionId: string): Omit<ToolArtifact, 'content'>[] {
    return this.db
      .prepare('SELECT id, session_id, tool, label, bytes, created_at FROM tool_artifacts WHERE session_id=? ORDER BY created_at')
      .all(sessionId)
      .map((r) => rowToObj(r));
  }
}
