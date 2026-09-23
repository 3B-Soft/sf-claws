import type { SQLQueryBindings } from 'bun:sqlite';
import type { AiModel, AiProvider, AgentRole, RoleModelBinding, Skill, PolicyRules } from '@sf-claws/shared';
import { type Db, nowIso, rowToObj } from '../db.js';
import { newId } from '../../lib/crypto.js';

export interface ProviderCredentialRow {
  provider: AiProvider;
  userId: string | null;
  apiKeyEnc: string;
  baseUrl: string | null;
  updatedAt: string;
}

/**
 * Provider API keys, either platform-wide (`userId` null) or belonging to one user. A user's own
 * key wins over the platform key, which is what lets a deployment give each consultant their own
 * provider account instead of everyone competing on one shared key and rate limit.
 */
export class ProvidersRepo {
  constructor(private db: Db) {}
  list(): ProviderCredentialRow[] {
    return this.db
      .prepare('SELECT * FROM provider_credentials WHERE user_id IS NULL')
      .all()
      .map((r) => rowToObj(r));
  }
  listForUser(userId: string): ProviderCredentialRow[] {
    return this.db
      .prepare('SELECT * FROM provider_credentials WHERE user_id=?')
      .all(userId)
      .map((r) => rowToObj(r));
  }
  get(provider: AiProvider, userId?: string | null): ProviderCredentialRow | undefined {
    const row = userId
      ? this.db.prepare('SELECT * FROM provider_credentials WHERE provider=? AND user_id=?').get(provider, userId)
      : this.db.prepare('SELECT * FROM provider_credentials WHERE provider=? AND user_id IS NULL').get(provider);
    return rowToObj(row);
  }
  set(provider: AiProvider, apiKeyEnc: string, baseUrl: string | null, updatedBy: string, userId: string | null = null): void {
    // Replace rather than ON CONFLICT: the uniqueness is enforced by partial indexes (NULL user_id
    // means "the global row"), and a partial index is an awkward upsert target in SQLite.
    const tx = this.db.transaction(() => {
      this.delete(provider, userId);
      this.db
        .prepare('INSERT INTO provider_credentials (provider, user_id, api_key_enc, base_url, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(provider, userId, apiKeyEnc, baseUrl, nowIso(), updatedBy);
    });
    tx();
  }
  delete(provider: AiProvider, userId: string | null = null): void {
    if (userId) this.db.prepare('DELETE FROM provider_credentials WHERE provider=? AND user_id=?').run(provider, userId);
    else this.db.prepare('DELETE FROM provider_credentials WHERE provider=? AND user_id IS NULL').run(provider);
  }
}

const toModel = (r: any) => rowToObj<AiModel>(r, { bools: ['enabled', 'supportsThinking'] });

export class ModelsRepo {
  constructor(private db: Db) {}
  list(): AiModel[] {
    return this.db.prepare('SELECT * FROM ai_models ORDER BY provider, label').all().map(toModel);
  }
  byId(id: string): AiModel | undefined {
    const r = this.db.prepare('SELECT * FROM ai_models WHERE id=?').get(r0(id));
    return r ? toModel(r) : undefined;
  }
  byProviderModel(provider: string, modelId: string): AiModel | undefined {
    const r = this.db.prepare('SELECT * FROM ai_models WHERE provider=? AND model_id=?').get(provider, modelId);
    return r ? toModel(r) : undefined;
  }
  create(input: Omit<AiModel, 'id' | 'createdAt'>): AiModel {
    const id = newId('mdl');
    this.db
      .prepare(`INSERT INTO ai_models (id, provider, model_id, label, enabled, input_cost_per_m, output_cost_per_m, cached_input_cost_per_m, max_output_tokens, context_window, supports_thinking, temperature, top_p, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.provider,
        input.modelId,
        input.label,
        input.enabled ? 1 : 0,
        input.inputCostPerM,
        input.outputCostPerM,
        input.cachedInputCostPerM ?? null,
        input.maxOutputTokens,
        input.contextWindow,
        input.supportsThinking ? 1 : 0,
        input.temperature ?? null,
        input.topP ?? null,
        nowIso(),
      );
    return this.byId(id)!;
  }
  update(id: string, patch: Partial<Omit<AiModel, 'id' | 'createdAt'>>): AiModel | undefined {
    const map: Record<string, string> = {
      provider: 'provider',
      modelId: 'model_id',
      label: 'label',
      enabled: 'enabled',
      inputCostPerM: 'input_cost_per_m',
      outputCostPerM: 'output_cost_per_m',
      cachedInputCostPerM: 'cached_input_cost_per_m',
      maxOutputTokens: 'max_output_tokens',
      contextWindow: 'context_window',
      supportsThinking: 'supports_thinking',
      temperature: 'temperature',
      topP: 'top_p',
    };
    const sets: string[] = [];
    const vals: SQLQueryBindings[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length) this.db.prepare(`UPDATE ai_models SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM ai_models WHERE id=?').run(id);
  }
}
const r0 = (s: string) => s;

export class BindingsRepo {
  constructor(private db: Db) {}
  list(): RoleModelBinding[] {
    return this.db
      .prepare('SELECT role, model_id, effort, max_iterations FROM role_bindings')
      .all()
      .map((r) => rowToObj<RoleModelBinding>(r));
  }
  get(role: AgentRole): RoleModelBinding | undefined {
    return rowToObj(this.db.prepare('SELECT role, model_id, effort, max_iterations FROM role_bindings WHERE role=?').get(role));
  }
  setAll(bindings: RoleModelBinding[]): void {
    const tx = this.db.transaction((items: RoleModelBinding[]) => {
      for (const b of items) {
        this.db
          .prepare(`INSERT INTO role_bindings (role, model_id, effort, max_iterations) VALUES (?, ?, ?, ?)
          ON CONFLICT(role) DO UPDATE SET model_id=excluded.model_id, effort=excluded.effort, max_iterations=excluded.max_iterations`)
          .run(b.role, b.modelId, b.effort, b.maxIterations);
      }
    });
    tx(bindings);
  }
}

const toSkill = (r: any) => rowToObj<Skill>(r, { bools: ['enabled'], json: ['roles'] });

export class SkillsRepo {
  constructor(private db: Db) {}
  list(filter: { clientId?: string | null; orgId?: string | null; enabledOnly?: boolean } = {}): Skill[] {
    // Global skills + skills scoped to the client + skills scoped to the org.
    const where: string[] = [];
    const vals: SQLQueryBindings[] = [];
    const scopes = ["scope='global'"];
    if (filter.clientId) {
      scopes.push("(scope='client' AND client_id=?)");
      vals.push(filter.clientId);
    }
    if (filter.orgId) {
      scopes.push("(scope='org' AND org_id=?)");
      vals.push(filter.orgId);
    }
    if (filter.clientId || filter.orgId) where.push(`(${scopes.join(' OR ')})`);
    if (filter.enabledOnly) where.push('enabled=1');
    const sql = `SELECT * FROM skills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY kind, name`;
    return this.db
      .prepare(sql)
      .all(...vals)
      .map(toSkill);
  }
  listAllRaw(): Skill[] {
    return this.db.prepare('SELECT * FROM skills ORDER BY scope, kind, name').all().map(toSkill);
  }
  byId(id: string): Skill | undefined {
    const r = this.db.prepare('SELECT * FROM skills WHERE id=?').get(id);
    return r ? toSkill(r) : undefined;
  }
  bySeedFile(file: string): Skill | undefined {
    const r = this.db.prepare('SELECT * FROM skills WHERE seed_file=?').get(file);
    return r ? toSkill(r) : undefined;
  }
  create(input: Omit<Skill, 'id' | 'version' | 'updatedAt'> & { seedFile?: string }): Skill {
    const id = newId('skl');
    this.db
      .prepare(
        `INSERT INTO skills (id, name, kind, scope, client_id, org_id, roles, content, enabled, version, updated_at, updated_by, seed_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.kind,
        input.scope,
        input.clientId ?? null,
        input.orgId ?? null,
        JSON.stringify(input.roles ?? []),
        input.content,
        input.enabled === false ? 0 : 1,
        nowIso(),
        input.updatedBy ?? null,
        input.seedFile ?? null,
      );
    return this.byId(id)!;
  }
  update(id: string, patch: Partial<Omit<Skill, 'id' | 'version' | 'updatedAt'>>): Skill | undefined {
    const map: Record<string, string> = {
      name: 'name',
      kind: 'kind',
      scope: 'scope',
      clientId: 'client_id',
      orgId: 'org_id',
      roles: 'roles',
      content: 'content',
      enabled: 'enabled',
      updatedBy: 'updated_by',
    };
    const sets: string[] = ['version=version+1', 'updated_at=?'];
    const vals: SQLQueryBindings[] = [nowIso()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(k === 'roles' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SQLQueryBindings));
    }
    this.db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id=?').run(id);
  }
}

export class PoliciesRepo {
  constructor(private db: Db) {}
  get(scopeKey: string): Partial<PolicyRules> | undefined {
    const r = this.db.prepare('SELECT rules FROM policies WHERE scope_key=?').get(scopeKey) as any;
    return r ? JSON.parse(r.rules) : undefined;
  }
  set(scopeKey: string, rules: Partial<PolicyRules>, updatedBy: string): void {
    this.db
      .prepare(`INSERT INTO policies (scope_key, rules, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET rules=excluded.rules, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(scopeKey, JSON.stringify(rules), nowIso(), updatedBy);
  }
}
