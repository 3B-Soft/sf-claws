import type { SQLQueryBindings } from 'bun:sqlite';
import type { Client, ClientMember, ClientMemberRole, SalesforceOrg, GithubRepo, OrgKind, OrgConnectionStatus } from '@sf-claws/shared';
import { type Db, nowIso, rowToObj } from '../db.js';
import { newId } from '../../lib/crypto.js';

export class ClientsRepo {
  constructor(private db: Db) {}
  list(): Client[] {
    return this.db
      .prepare('SELECT * FROM clients ORDER BY name')
      .all()
      .map((r) => rowToObj<Client>(r));
  }
  byId(id: string): Client | undefined {
    return rowToObj<Client>(this.db.prepare('SELECT * FROM clients WHERE id=?').get(id));
  }
  bySlug(slug: string): Client | undefined {
    return rowToObj<Client>(this.db.prepare('SELECT * FROM clients WHERE slug=?').get(slug));
  }
  create(input: { name: string; slug: string; description?: string }): Client {
    const id = newId('cli');
    this.db
      .prepare('INSERT INTO clients (id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.slug, input.description ?? null, nowIso());
    return this.byId(id)!;
  }
  update(id: string, patch: Partial<{ name: string; description: string | null; instructions: string | null }>): Client | undefined {
    if (patch.name !== undefined) this.db.prepare('UPDATE clients SET name=? WHERE id=?').run(patch.name, id);
    if (patch.description !== undefined) this.db.prepare('UPDATE clients SET description=? WHERE id=?').run(patch.description, id);
    if (patch.instructions !== undefined) this.db.prepare('UPDATE clients SET instructions=? WHERE id=?').run(patch.instructions || null, id);
    return this.byId(id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM clients WHERE id=?').run(id);
  }
}

/**
 * Client membership. Every read is scoped by user or by client except `listAll`, the admin
 * console's inventory, which is documented in the tenant-isolation allowlist.
 */
const MEMBER_COLS = 'm.user_id, m.client_id, m.role, m.created_at, u.email, u.display_name, c.name AS client_name';

export class ClientMembersRepo {
  constructor(private db: Db) {}
  listByClient(clientId: string): ClientMember[] {
    return this.db
      .prepare(
        `SELECT ${MEMBER_COLS} FROM client_members m JOIN users u ON u.id=m.user_id JOIN clients c ON c.id=m.client_id WHERE m.client_id=? ORDER BY u.display_name`,
      )
      .all(clientId)
      .map((r) => rowToObj<ClientMember>(r));
  }
  listByUser(userId: string): ClientMember[] {
    return this.db
      .prepare(
        `SELECT ${MEMBER_COLS} FROM client_members m JOIN users u ON u.id=m.user_id JOIN clients c ON c.id=m.client_id WHERE m.user_id=? ORDER BY c.name`,
      )
      .all(userId)
      .map((r) => rowToObj<ClientMember>(r));
  }
  /** Every membership in the deployment: the admin console's users page shows who belongs where. */
  listAll(): ClientMember[] {
    return this.db
      .prepare(`SELECT ${MEMBER_COLS} FROM client_members m JOIN users u ON u.id=m.user_id JOIN clients c ON c.id=m.client_id ORDER BY c.name, u.display_name`)
      .all()
      .map((r) => rowToObj<ClientMember>(r));
  }
  get(userId: string, clientId: string): { role: ClientMemberRole } | undefined {
    return rowToObj<{ role: ClientMemberRole }>(this.db.prepare('SELECT role FROM client_members WHERE user_id=? AND client_id=?').get(userId, clientId));
  }
  clientIdsForUser(userId: string): string[] {
    return this.db
      .prepare('SELECT client_id FROM client_members WHERE user_id=?')
      .all(userId)
      .map((r: any) => r.client_id as string);
  }
  set(userId: string, clientId: string, role: ClientMemberRole): void {
    this.db
      .prepare(
        'INSERT INTO client_members (user_id, client_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, client_id) DO UPDATE SET role=excluded.role',
      )
      .run(userId, clientId, role, nowIso());
  }
  remove(userId: string, clientId: string): boolean {
    return this.db.prepare('DELETE FROM client_members WHERE user_id=? AND client_id=?').run(userId, clientId).changes > 0;
  }
}

export interface OrgSecrets {
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  consumerSecretEnc: string | null;
}
export interface OrgRow extends SalesforceOrg {
  myDomainHost: string | null;
  lastError: string | null;
}

const ORG_COLS =
  'id, client_id, label, kind, sf_org_id, instance_url, my_domain_host, login_url, consumer_key, api_version, username, status, protected, instructions, created_at, last_connected_at, last_error';
const toOrg = (r: any): OrgRow => {
  const o = rowToObj<OrgRow>(r, { bools: ['protected'] });
  (o as any).githubRepoId = null;
  return o;
};

export class OrgsRepo {
  constructor(private db: Db) {}
  listByClient(clientId: string): OrgRow[] {
    return this.db.prepare(`SELECT ${ORG_COLS} FROM orgs WHERE client_id=? ORDER BY label`).all(clientId).map(toOrg);
  }
  listAll(): OrgRow[] {
    return this.db.prepare(`SELECT ${ORG_COLS} FROM orgs ORDER BY label`).all().map(toOrg);
  }
  byId(id: string): OrgRow | undefined {
    const r = this.db.prepare(`SELECT ${ORG_COLS} FROM orgs WHERE id=?`).get(id);
    return r ? toOrg(r) : undefined;
  }
  byHost(host: string): OrgRow[] {
    const h = host.toLowerCase();
    return this.db.prepare(`SELECT ${ORG_COLS} FROM orgs WHERE lower(my_domain_host)=? OR lower(instance_url) LIKE ?`).all(h, `%//${h}%`).map(toOrg);
  }
  bySfOrgId(sfOrgId: string): OrgRow[] {
    return this.db.prepare(`SELECT ${ORG_COLS} FROM orgs WHERE sf_org_id=? OR substr(sf_org_id,1,15)=substr(?,1,15)`).all(sfOrgId, sfOrgId).map(toOrg);
  }
  secrets(id: string): OrgSecrets {
    return (
      rowToObj<OrgSecrets>(this.db.prepare('SELECT access_token_enc, refresh_token_enc, consumer_secret_enc FROM orgs WHERE id=?').get(id)) ?? {
        accessTokenEnc: null,
        refreshTokenEnc: null,
        consumerSecretEnc: null,
      }
    );
  }
  create(input: {
    clientId: string;
    label: string;
    kind: OrgKind;
    loginUrl: string;
    apiVersion: string;
    protected: boolean;
    consumerKey?: string | null;
    consumerSecretEnc?: string | null;
  }): OrgRow {
    const id = newId('org');
    this.db
      .prepare(
        `INSERT INTO orgs (id, client_id, label, kind, login_url, consumer_key, consumer_secret_enc, api_version, status, protected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'disconnected', ?, ?)`,
      )
      .run(
        id,
        input.clientId,
        input.label,
        input.kind,
        input.loginUrl,
        input.consumerKey ?? null,
        input.consumerSecretEnc ?? null,
        input.apiVersion,
        input.protected ? 1 : 0,
        nowIso(),
      );
    return this.byId(id)!;
  }
  update(
    id: string,
    patch: Partial<{
      label: string;
      kind: OrgKind;
      loginUrl: string;
      consumerKey: string | null;
      consumerSecretEnc: string | null;
      apiVersion: string;
      protected: boolean;
      status: OrgConnectionStatus;
      sfOrgId: string | null;
      instanceUrl: string | null;
      myDomainHost: string | null;
      username: string | null;
      lastConnectedAt: string | null;
      lastError: string | null;
      accessTokenEnc: string | null;
      refreshTokenEnc: string | null;
      instructions: string | null;
    }>,
  ): OrgRow | undefined {
    const map: Record<string, string> = {
      label: 'label',
      kind: 'kind',
      loginUrl: 'login_url',
      consumerKey: 'consumer_key',
      consumerSecretEnc: 'consumer_secret_enc',
      apiVersion: 'api_version',
      protected: 'protected',
      status: 'status',
      sfOrgId: 'sf_org_id',
      instanceUrl: 'instance_url',
      myDomainHost: 'my_domain_host',
      username: 'username',
      lastConnectedAt: 'last_connected_at',
      lastError: 'last_error',
      accessTokenEnc: 'access_token_enc',
      refreshTokenEnc: 'refresh_token_enc',
      instructions: 'instructions',
    };
    const sets: string[] = [];
    const vals: SQLQueryBindings[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length) this.db.prepare(`UPDATE orgs SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM orgs WHERE id=?').run(id);
  }
}

export class OAuthStatesRepo {
  constructor(private db: Db) {}
  create(state: string, orgId: string, userId: string, codeVerifier: string, ttlMs = 10 * 60_000): void {
    this.db
      .prepare('INSERT INTO oauth_states (state, org_id, user_id, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(state, orgId, userId, codeVerifier, nowIso(), new Date(Date.now() + ttlMs).toISOString());
  }
  consume(state: string): { orgId: string; userId: string; codeVerifier: string } | undefined {
    const r = rowToObj<any>(this.db.prepare('SELECT org_id, user_id, code_verifier, expires_at FROM oauth_states WHERE state=?').get(state));
    if (!r) return undefined;
    this.db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
    if (r.expiresAt < nowIso()) return undefined;
    return r;
  }
}

export interface GithubRepoRow extends GithubRepo {
  tokenEnc: string | null;
}
const toRepo = (r: any): GithubRepoRow | undefined => {
  if (!r) return undefined;
  const o = rowToObj<any>(r);
  o.hasToken = !!o.tokenEnc;
  return o;
};

export class GithubReposRepo {
  constructor(private db: Db) {}
  byClient(clientId: string): GithubRepoRow | undefined {
    return toRepo(this.db.prepare('SELECT * FROM github_repos WHERE client_id=?').get(clientId));
  }
  byId(id: string): GithubRepoRow | undefined {
    return toRepo(this.db.prepare('SELECT * FROM github_repos WHERE id=?').get(id));
  }
  upsert(
    clientId: string,
    input: {
      owner: string;
      repo: string;
      defaultBranch: string;
      sourceRoot: string;
      docsRoot: string;
      commitStrategy: string;
      branchPrefix: string;
      tokenEnc?: string | null;
    },
  ): GithubRepoRow {
    const existing = this.byClient(clientId);
    const now = nowIso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE github_repos SET owner=?, repo=?, default_branch=?, source_root=?, docs_root=?, commit_strategy=?, branch_prefix=?, token_enc=COALESCE(?, token_enc), updated_at=? WHERE client_id=?`,
        )
        .run(
          input.owner,
          input.repo,
          input.defaultBranch,
          input.sourceRoot,
          input.docsRoot,
          input.commitStrategy,
          input.branchPrefix,
          input.tokenEnc ?? null,
          now,
          clientId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO github_repos (id, client_id, owner, repo, default_branch, source_root, docs_root, commit_strategy, branch_prefix, token_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('gh'),
          clientId,
          input.owner,
          input.repo,
          input.defaultBranch,
          input.sourceRoot,
          input.docsRoot,
          input.commitStrategy,
          input.branchPrefix,
          input.tokenEnc ?? null,
          now,
          now,
        );
    }
    return this.byClient(clientId)!;
  }
  delete(clientId: string): void {
    this.db.prepare('DELETE FROM github_repos WHERE client_id=?').run(clientId);
  }
}
