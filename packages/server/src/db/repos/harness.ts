import type { CheckpointSummary, HydrationBundle, WorkspaceFile } from '@sf-claws/shared';
import type { Db } from '../db.js';
import type { CompileState } from '../../agents/compile-control.js';
import type { DeployOutcome, TestLevel } from '../../salesforce/service.js';
import type { ToolingMember } from '../../salesforce/tooling-compile.js';
import { newId, sha256 } from '../../lib/crypto.js';
import { WorkspaceRepo } from './sessions.js';
import { CompileControlRepo } from './compile-control.js';

export interface ValidationPayload {
  apiVersion: string;
  files: { path: string; content: string }[];
  deleted: { type: string; fullName: string }[];
  testLevel: TestLevel;
  runTests: string[];
  zipBase64?: string;
  members?: ToolingMember[];
}
export interface Checkpoint extends CheckpointSummary {
  orgId: string;
  workspace: WorkspaceFile[];
  control: CompileState;
  payload: ValidationPayload;
}
export interface ValidationAttempt {
  number: number;
  startedAt: string;
  finishedAt?: string;
  phase: 'submitting' | 'polling' | 'finished' | 'uncertain';
  remoteId?: string;
  containerId?: string;
  outcome?: DeployOutcome;
  error?: string;
  retryAt?: number;
}
const decode = (row: any): Checkpoint | undefined =>
  row
    ? {
        ...JSON.parse(row.snapshot),
        status: row.status,
        rootCount: row.root_count,
        restoredFrom: row.restored_from ?? null,
      }
    : undefined;

export class HarnessRepo {
  constructor(private db: Db) {}
  create(input: Omit<Checkpoint, 'id' | 'createdAt' | 'payloadHash' | 'status' | 'rootCount' | 'restoredFrom'>): Checkpoint {
    const checkpoint: Checkpoint = {
      ...input,
      id: newId('checkpoint'),
      createdAt: new Date().toISOString(),
      payloadHash: sha256(JSON.stringify(input.payload)),
      status: 'in_progress',
      rootCount: null,
      restoredFrom: null,
    };
    this.db
      .prepare(
        'INSERT INTO validation_checkpoints (id, session_id, org_id, deploy_id, status, comparison_key, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        checkpoint.id,
        input.sessionId,
        input.orgId,
        input.deployId,
        checkpoint.status,
        input.comparisonKey,
        JSON.stringify(checkpoint),
        checkpoint.createdAt,
      );
    return checkpoint;
  }
  get(sessionId: string, id: string): Checkpoint | undefined {
    return decode(this.db.prepare('SELECT * FROM validation_checkpoints WHERE session_id=? AND id=?').get(sessionId, id));
  }
  list(sessionId: string): Checkpoint[] {
    return this.db
      .prepare('SELECT * FROM validation_checkpoints WHERE session_id=? ORDER BY rowid DESC LIMIT 100')
      .all(sessionId)
      .map((r) => decode(r)!);
  }
  active(orgId: string): Checkpoint | undefined {
    return decode(this.db.prepare("SELECT * FROM validation_checkpoints WHERE org_id=? AND status IN ('in_progress','uncertain') LIMIT 1").get(orgId));
  }
  previous(sessionId: string, comparisonKey: string, except: string): Checkpoint | undefined {
    return decode(
      this.db
        .prepare(
          "SELECT * FROM validation_checkpoints WHERE session_id=? AND comparison_key=? AND id<>? AND status IN ('succeeded','failed') AND root_count IS NOT NULL ORDER BY rowid DESC LIMIT 1",
        )
        .get(sessionId, comparisonKey, except),
    );
  }
  finish(sessionId: string, id: string, status: CheckpointSummary['status'], roots: number | null): void {
    this.db.prepare('UPDATE validation_checkpoints SET status=?, root_count=? WHERE session_id=? AND id=?').run(status, roots, sessionId, id);
  }
  attempts(sessionId: string, id: string): ValidationAttempt[] {
    if (!this.get(sessionId, id)) return [];
    return this.db
      .prepare('SELECT state FROM validation_attempts WHERE checkpoint_id=? ORDER BY attempt')
      .all(id)
      .map((r: any) => JSON.parse(r.state));
  }
  attempt(sessionId: string, id: string, attempt: ValidationAttempt): void {
    if (!this.get(sessionId, id)) throw new Error('Checkpoint not found');
    this.db
      .prepare(
        'INSERT INTO validation_attempts (checkpoint_id, attempt, state) VALUES (?, ?, ?) ON CONFLICT(checkpoint_id, attempt) DO UPDATE SET state=excluded.state',
      )
      .run(id, attempt.number, JSON.stringify(attempt));
  }
  startAttempt(sessionId: string, id: string, attempt: ValidationAttempt): void {
    this.db.transaction(() => {
      const checkpoint = this.get(sessionId, id);
      if (!checkpoint || !['in_progress', 'uncertain'].includes(checkpoint.status)) throw new Error('Checkpoint is no longer active');
      const count = (this.db.prepare('SELECT COALESCE(MAX(attempt),0) n FROM validation_attempts WHERE checkpoint_id=?').get(id) as any).n;
      if (count !== attempt.number - 1) throw new Error('Another controller already advanced this checkpoint; reconcile its existing attempt');
      this.db.prepare('INSERT INTO validation_attempts (checkpoint_id, attempt, state) VALUES (?, ?, ?)').run(id, attempt.number, JSON.stringify(attempt));
    })();
  }
  /** Restore only the staged DB workspace, atomically. Never touches live Salesforce or Git. */
  restore(sessionId: string, failed: string, previous: Checkpoint, state: CompileState): void {
    if (previous.sessionId !== sessionId || !this.get(sessionId, failed)) throw new Error('Checkpoint scope mismatch');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workspace_files WHERE session_id=?').run(sessionId);
      const workspace = new WorkspaceRepo(this.db);
      for (const file of previous.workspace) workspace.upsert(sessionId, file);
      new CompileControlRepo(this.db).set(sessionId, state);
      this.db
        .prepare("UPDATE validation_checkpoints SET status='quarantined', restored_from=? WHERE session_id=? AND id=?")
        .run(previous.id, sessionId, failed);
    })();
  }
  revision(orgId: string): number {
    return (this.db.prepare('SELECT schema_revision FROM orgs WHERE id=?').get(orgId) as any)?.schema_revision ?? 0;
  }
  invalidate(orgId: string): void {
    this.db.prepare('UPDATE orgs SET schema_revision=schema_revision+1 WHERE id=?').run(orgId);
  }
  hydration(sessionId: string): HydrationBundle | undefined {
    const row = this.db.prepare('SELECT bundle FROM session_hydration WHERE session_id=?').get(sessionId) as any;
    return row ? JSON.parse(row.bundle) : undefined;
  }
  saveHydration(bundle: HydrationBundle): void {
    this.db
      .prepare('INSERT INTO session_hydration (session_id, bundle) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET bundle=excluded.bundle')
      .run(bundle.sessionId, JSON.stringify(bundle));
  }
}
