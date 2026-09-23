import type { SQLQueryBindings } from 'bun:sqlite';
import type { AgentRole, CustomAgent, KnowledgeSource, KnowledgeSourceKind } from '@sf-claws/shared';
import { type Db, nowIso, rowToObj } from '../db.js';
import { newId } from '../../lib/crypto.js';

export interface KnowledgeSourceRow extends KnowledgeSource {
  tokenEnc: string | null;
}

const toRow = (r: any): KnowledgeSourceRow | undefined => {
  if (!r) return undefined;
  const o = rowToObj<KnowledgeSourceRow>(r, { bools: ['enabled'] });
  return { ...o, hasToken: !!r.token_enc };
};

export class KnowledgeSourcesRepo {
  constructor(private db: Db) {}

  /**
   * Sources visible to a client: everything global, plus that client's own. A client-scoped source
   * is never visible to another client — the same tenant boundary the rest of the data follows.
   */
  forClient(clientId: string, enabledOnly = true): KnowledgeSourceRow[] {
    const sql = `SELECT * FROM knowledge_sources WHERE (scope='global' OR (scope='client' AND client_id=?)) ${enabledOnly ? 'AND enabled=1' : ''} ORDER BY kind, name`;
    return this.db
      .prepare(sql)
      .all(clientId)
      .map((r) => toRow(r)!);
  }

  listAll(): KnowledgeSourceRow[] {
    return this.db
      .prepare('SELECT * FROM knowledge_sources ORDER BY scope, kind, name')
      .all()
      .map((r) => toRow(r)!);
  }

  byId(id: string): KnowledgeSourceRow | undefined {
    return toRow(this.db.prepare('SELECT * FROM knowledge_sources WHERE id=?').get(id));
  }

  /** Resolve by id or by (case-insensitive) name, scoped to what this client may see. */
  resolve(clientId: string, nameOrId: string): KnowledgeSourceRow | undefined {
    const wanted = nameOrId.trim().toLowerCase();
    return this.forClient(clientId).find((s) => s.id === nameOrId || s.name.toLowerCase() === wanted || s.repoRef.toLowerCase() === wanted);
  }

  create(input: {
    kind: KnowledgeSourceKind;
    name: string;
    repoRef: string;
    guidance?: string;
    scope: 'global' | 'client';
    clientId?: string | null;
    tokenEnc?: string | null;
    enabled?: boolean;
  }): KnowledgeSourceRow {
    const id = newId('kns');
    const now = nowIso();
    this.db
      .prepare(`INSERT INTO knowledge_sources (id, kind, name, repo_ref, guidance, scope, client_id, token_enc, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.kind,
        input.name,
        input.repoRef,
        input.guidance ?? '',
        input.scope,
        input.clientId ?? null,
        input.tokenEnc ?? null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.byId(id)!;
  }

  update(
    id: string,
    patch: Partial<{
      name: string;
      repoRef: string;
      guidance: string;
      enabled: boolean;
      tokenEnc: string | null;
      scope: 'global' | 'client';
      clientId: string | null;
    }>,
  ): KnowledgeSourceRow | undefined {
    const map: Record<string, string> = {
      name: 'name',
      repoRef: 'repo_ref',
      guidance: 'guidance',
      enabled: 'enabled',
      tokenEnc: 'token_enc',
      scope: 'scope',
      clientId: 'client_id',
    };
    const sets: string[] = ['updated_at=?'];
    const vals: SQLQueryBindings[] = [nowIso()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    this.db.prepare(`UPDATE knowledge_sources SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM knowledge_sources WHERE id=?').run(id);
  }
}

const toAgent = (r: any): CustomAgent | undefined => (r ? rowToObj<CustomAgent>(r, { bools: ['enabled'] }) : undefined);

/**
 * Specialists defined by a super admin. They layer instructions on a built-in role rather than
 * defining their own tool set, so adding one can never widen what an agent may do to an org.
 */
export class CustomAgentsRepo {
  constructor(private db: Db) {}

  /** Specialists visible to a client: global ones plus that client's own. */
  forClient(clientId: string, enabledOnly = true): CustomAgent[] {
    const sql = `SELECT * FROM custom_agents WHERE (scope='global' OR (scope='client' AND client_id=?)) ${enabledOnly ? 'AND enabled=1' : ''} ORDER BY name`;
    return this.db
      .prepare(sql)
      .all(clientId)
      .map((r) => toAgent(r)!);
  }

  listAll(): CustomAgent[] {
    return this.db
      .prepare('SELECT * FROM custom_agents ORDER BY scope, name')
      .all()
      .map((r) => toAgent(r)!);
  }

  byId(id: string): CustomAgent | undefined {
    return toAgent(this.db.prepare('SELECT * FROM custom_agents WHERE id=?').get(id));
  }

  /** Resolve by id or name, scoped to what this client may see. */
  resolve(clientId: string, nameOrId: string): CustomAgent | undefined {
    const wanted = nameOrId.trim().toLowerCase();
    return this.forClient(clientId).find((a) => a.id === nameOrId || a.name.toLowerCase() === wanted);
  }

  create(input: {
    name: string;
    whenToUse: string;
    baseRole: AgentRole;
    instructions: string;
    scope: 'global' | 'client';
    clientId?: string | null;
    enabled?: boolean;
  }): CustomAgent {
    const id = newId('cag');
    const now = nowIso();
    this.db
      .prepare(`INSERT INTO custom_agents (id, name, when_to_use, base_role, instructions, scope, client_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.whenToUse, input.baseRole, input.instructions, input.scope, input.clientId ?? null, input.enabled === false ? 0 : 1, now, now);
    return this.byId(id)!;
  }

  update(
    id: string,
    patch: Partial<{
      name: string;
      whenToUse: string;
      baseRole: AgentRole;
      instructions: string;
      enabled: boolean;
      scope: 'global' | 'client';
      clientId: string | null;
    }>,
  ): CustomAgent | undefined {
    const map: Record<string, string> = {
      name: 'name',
      whenToUse: 'when_to_use',
      baseRole: 'base_role',
      instructions: 'instructions',
      enabled: 'enabled',
      scope: 'scope',
      clientId: 'client_id',
    };
    const sets: string[] = ['updated_at=?'];
    const vals: SQLQueryBindings[] = [nowIso()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    this.db.prepare(`UPDATE custom_agents SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM custom_agents WHERE id=?').run(id);
  }
}
