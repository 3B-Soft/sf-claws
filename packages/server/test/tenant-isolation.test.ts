import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretBox } from '../src/lib/crypto.js';
import { buildApp } from '../src/http/app.js';
import { makeContext, seedClientOrgUser } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = path.join(HERE, '..', 'src', 'db', 'repos');

/**
 * Tables holding data that belongs to one tenant, with the column that scopes them. Every read of
 * these must be filtered — this is the boundary that keeps one client's org, sessions and secrets
 * away from another's, and code review is not a reliable way to enforce it forever.
 *
 * A row here is a commitment: if you add a tenant-scoped table, add it to this list.
 */
const TENANT_TABLES: Record<string, string[]> = {
  sessions: ['client_id', 'org_id', 'user_id', 'id'],
  session_events: ['session_id'],
  session_messages: ['session_id'],
  workspace_files: ['session_id'],
  deploy_runs: ['session_id', 'org_id', 'id'],
  confirmations: ['session_id', 'id'],
  docs: ['session_id', 'client_id', 'org_id', 'id'],
  usage_records: ['session_id', 'client_id', 'user_id'],
  tool_invocations: ['session_id', 'client_id'],
  tool_artifacts: ['session_id', 'id'],
  session_todos: ['session_id'],
  session_notes: ['session_id', 'id'],
  session_permissions: ['session_id'],
  org_limits: ['org_id'],
  orgs: ['client_id', 'id'],
  github_repos: ['client_id', 'id'],
  client_members: ['client_id', 'user_id'],
  projects: ['client_id', 'id'],
  tasks: ['project_id', 'id'],
};

/** Statements that legitimately read across tenants, with the reason each one is safe. */
const CROSS_TENANT_ALLOWLIST: { file: string; fragment: string; why: string }[] = [
  { file: 'sessions.ts', fragment: 'FROM sessions ${where.length', why: 'admin session list; filters are applied from validated query params' },
  { file: 'sessions.ts', fragment: 'COUNT(*) c FROM sessions WHERE created_at>=?', why: 'aggregate count for the admin dashboard, exposes no tenant data' },
  { file: 'sessions.ts', fragment: 'FROM usage_records WHERE created_at>=? AND created_at<=? GROUP BY', why: 'admin usage rollup, grouped aggregate' },
  { file: 'sessions.ts', fragment: 'SUM(cost_usd),0) c FROM usage_records WHERE created_at>=?', why: 'platform-wide spend total for the admin dashboard' },
  { file: 'sessions.ts', fragment: 'FROM tool_invocations WHERE created_at>=? AND created_at<=? GROUP BY', why: 'admin per-tool rollup, grouped aggregate' },
  { file: 'clients.ts', fragment: 'FROM orgs ORDER BY', why: 'admin org inventory' },
  {
    file: 'clients.ts',
    fragment: 'JOIN clients c ON c.id=m.client_id ORDER BY c.name, u.display_name',
    why: 'listAll: the admin console users page shows which clients each user belongs to; admin-only route, exposes memberships and names, no tenant data',
  },
  {
    file: 'clients.ts',
    fragment: 'FROM orgs WHERE lower(my_domain_host)=? OR lower(instance_url) LIKE ?',
    why: 'the extension resolves which registered org a Salesforce tab belongs to before any client context exists; the lookup is by host, returns only that org and its client name, and the session it creates is then scoped to that org',
  },
  {
    file: 'clients.ts',
    fragment: 'FROM orgs WHERE sf_org_id=? OR substr(sf_org_id,1,15)=substr(?,1,15)',
    why: 'same tab-resolution path, keyed on the Salesforce org id the page reports',
  },
  { file: 'projects.ts', fragment: 'FROM projects ORDER BY created_at DESC', why: 'listAll: admin-only project inventory, never called from a session' },
  {
    file: 'projects.ts',
    fragment: 'FROM tasks WHERE ${where.join(',
    why: 'the filter list is built from validated params and tasks.list throws when it would be empty — proven by "refuses an unfiltered task read" below, since the static check cannot see through the interpolation',
  },
];

function readRepoSources(): { file: string; sql: string[] }[] {
  return fs
    .readdirSync(REPOS_DIR)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((file) => {
      const source = fs.readFileSync(path.join(REPOS_DIR, file), 'utf8');
      // Every SQL string in the repo layer, normalised to one line.
      const statements = [...source.matchAll(/(?:SELECT|DELETE)\s[\s\S]*?(?=`|'|")/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim());
      return { file, sql: statements };
    });
}

describe('tenant scoping', () => {
  it('never reads a tenant-scoped table without a scoping predicate', () => {
    const violations: string[] = [];
    for (const { file, sql } of readRepoSources()) {
      for (const statement of sql) {
        const from = /\bFROM\s+([a-z_]+)/i.exec(statement);
        if (!from) continue;
        const table = from[1].toLowerCase();
        const scopes = TENANT_TABLES[table];
        if (!scopes) continue;
        const allowed = CROSS_TENANT_ALLOWLIST.some((a) => a.file === file && statement.includes(a.fragment.replace(/\s+/g, ' ')));
        if (allowed) continue;
        const where = statement.slice(statement.toUpperCase().indexOf(' WHERE '));
        const scoped = statement.toUpperCase().includes(' WHERE ') && scopes.some((col) => new RegExp(`\\b${col}\\s*(=|IN)`, 'i').test(where));
        if (!scoped) violations.push(`${file}: ${statement.slice(0, 140)}`);
      }
    }
    expect(
      violations,
      `Unscoped reads of tenant data:\n${violations.join('\n')}\n\nAdd a scoping predicate, or document the exception in CROSS_TENANT_ALLOWLIST with a reason.`,
    ).toEqual([]);
  });

  it('keeps the cross-tenant allowlist honest', () => {
    // Every documented exception must still exist; a stale entry hides a real regression later.
    for (const entry of CROSS_TENANT_ALLOWLIST) {
      const source = fs.readFileSync(path.join(REPOS_DIR, entry.file), 'utf8').replace(/\s+/g, ' ');
      expect(source, `Allowlist entry no longer matches any statement: ${entry.file} / ${entry.fragment}`).toContain(entry.fragment.replace(/\s+/g, ' '));
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });
});

describe('envelope encryption', () => {
  const store = () => {
    const keys = new Map<string, string>();
    return {
      get: (k: string) => keys.get(k),
      put: (k: string, v: string) => {
        keys.set(k, v);
      },
      size: () => keys.size,
    };
  };

  it('encrypts a tenant secret under that tenant key, not the master key', () => {
    const keyStore = store();
    const box = new SecretBox('bWFzdGVya2V5bWFzdGVya2V5bWFzdGVya2V5MTI=', keyStore);
    const boxed = box.encryptFor('client-a', 'refresh-token');
    expect(boxed.startsWith('v2.client-a.')).toBe(true);
    expect(box.decrypt(boxed)).toBe('refresh-token');
    expect(keyStore.size()).toBe(1);
  });

  it('cannot decrypt one tenant ciphertext with another tenant key', () => {
    const keyStore = store();
    const box = new SecretBox('bWFzdGVya2V5bWFzdGVya2V5bWFzdGVya2V5MTI=', keyStore);
    const a = box.encryptFor('client-a', 'a-secret');
    // Swap in client-b's key id: the tag check must fail rather than silently returning garbage.
    box.encryptFor('client-b', 'b-secret');
    const forged = a.replace('v2.client-a.', 'v2.client-b.');
    expect(() => box.decrypt(forged)).toThrow();
  });

  it('still reads v1 secrets written before envelope encryption existed', () => {
    const box = new SecretBox('bWFzdGVya2V5bWFzdGVya2V5bWFzdGVya2V5MTI=', store());
    const legacy = box.encrypt('old-secret');
    expect(legacy.startsWith('v1.')).toBe(true);
    expect(box.decrypt(legacy)).toBe('old-secret');
  });

  it('refuses a secret whose data key this server does not hold', () => {
    const box = new SecretBox('bWFzdGVya2V5bWFzdGVya2V5bWFzdGVya2V5MTI=', store());
    expect(() => box.decrypt('v2.unknown-tenant.aaaa.bbbb.cccc')).toThrow(/cannot be decrypted/);
  });

  it('rotates a tenant key without touching other tenants', () => {
    const keyStore = store();
    const box = new SecretBox('bWFzdGVya2V5bWFzdGVya2V5bWFzdGVya2V5MTI=', keyStore);
    const bSecret = box.encryptFor('client-b', 'b-secret');
    box.encryptFor('client-a', 'a-secret');
    box.rotateTenantKey('client-a');
    // The rotated tenant needs its secrets rewritten; everyone else is unaffected.
    expect(box.decrypt(bSecret)).toBe('b-secret');
    expect(box.decrypt(box.encryptFor('client-a', 'new-secret'))).toBe('new-secret');
  });

  it('stores Salesforce refresh tokens under the owning client key', async () => {
    const ctx = makeContext();
    const { org, client } = await seedClientOrgUser(ctx);
    const boxed = ctx.secrets.encryptFor(client.id, 'rt-value');
    ctx.repos.orgs.update(org.id, { refreshTokenEnc: boxed });
    const stored = ctx.repos.orgs.secrets(org.id).refreshTokenEnc!;
    expect(stored.startsWith(`v2.${client.id}.`)).toBe(true);
    expect(ctx.secrets.decrypt(stored)).toBe('rt-value');
  });
});

describe('runtime scoping guards', () => {
  it("refuses an unfiltered task read rather than returning every client's tasks", async () => {
    const ctx = makeContext();
    const { client } = await seedClientOrgUser(ctx);
    const project = ctx.repos.projects.create({ clientId: client.id, name: 'P' });
    ctx.repos.tasks.create({ projectId: project.id, title: 'T' });
    expect(() => ctx.repos.tasks.list({})).toThrow(/requires at least one filter/);
    expect(ctx.repos.tasks.list({ projectId: project.id })).toHaveLength(1);
  });

  it('scopes project listing to one client', async () => {
    const ctx = makeContext();
    const { client } = await seedClientOrgUser(ctx);
    const other = ctx.repos.clients.create({ name: 'Other', slug: 'other' });
    ctx.repos.projects.create({ clientId: client.id, name: 'Mine' });
    ctx.repos.projects.create({ clientId: other.id, name: 'Theirs' });
    expect(ctx.repos.projects.list(client.id).map((p) => p.name)).toEqual(['Mine']);
    expect(ctx.repos.projects.listAll()).toHaveLength(2);
  });
});

describe('session data scoping', () => {
  it('does not leak another client session through the snapshot API', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const otherClient = ctx.repos.clients.create({ name: 'Other', slug: 'other' });
    const otherOrg = ctx.repos.orgs.create({
      clientId: otherClient.id,
      label: 'Other UAT',
      kind: 'sandbox',
      loginUrl: 'https://test.salesforce.com',
      apiVersion: '62.0',
      protected: false,
    });

    const mine = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const theirs = ctx.runtime.createSession({ userId: user.id, orgId: otherOrg.id, uiMode: 'visual' });
    ctx.repos.notes.upsert({ sessionId: theirs.id, agentId: 'a', role: 'analyst', title: 'their secret', content: 'confidential', tags: [] });

    const snapshot = ctx.runtime.snapshot(mine.id);
    expect(snapshot.notes).toHaveLength(0);
    expect(ctx.repos.notes.list(mine.id)).toHaveLength(0);
    expect(ctx.repos.notes.list(theirs.id)).toHaveLength(1);
  });
});

/**
 * The HTTP boundary. Every route addressed by an org, a client, a session or something owned by
 * one of them must refuse a caller who is not a member of that client, whatever their platform
 * role. This walks the real route table so a new route cannot be added without either going
 * through `requireClientAccess` / `requireOrgAccess` or being listed here with a reason.
 */
describe('route-level client scoping', () => {
  const PARAMS = [':orgId', ':clientId', ':id', ':docId', ':logId', ':sobject', ':command', ':userId', ':provider'];
  /** Routes with a tenant-looking parameter that are legitimately reachable by a non-member, each with the reason. */
  const ROUTE_ALLOWLIST: { method: string; url: string; why: string }[] = [
    { method: 'POST', url: '/api/v1/admin/users/:id/approve', why: 'user administration; :id is a user, not a tenant' },
    { method: 'POST', url: '/api/v1/admin/users/:id/disable', why: 'user administration; :id is a user, not a tenant' },
    { method: 'PATCH', url: '/api/v1/admin/users/:id', why: 'user administration; :id is a user, not a tenant' },
    { method: 'GET', url: '/api/v1/admin/users/:id/clients', why: 'user administration; :id is a user, lists their memberships' },
    { method: 'PUT', url: '/api/v1/admin/users/:id/clients', why: 'user administration; :id is a user, super admin sets their memberships' },
    { method: 'PUT', url: '/api/v1/admin/providers/:provider', why: 'platform AI key, super admin only, no tenant data' },
    { method: 'DELETE', url: '/api/v1/admin/providers/:provider', why: 'platform AI key, super admin only, no tenant data' },
    { method: 'POST', url: '/api/v1/admin/providers/:provider/test', why: 'platform AI key probe, admin only, no tenant data' },
    { method: 'PUT', url: '/api/v1/me/providers/:provider', why: "the caller's own AI key" },
    { method: 'DELETE', url: '/api/v1/me/providers/:provider', why: "the caller's own AI key" },
    { method: 'PATCH', url: '/api/v1/admin/models/:id', why: 'platform model registry, super admin only, no tenant data' },
    { method: 'DELETE', url: '/api/v1/admin/models/:id', why: 'platform model registry, super admin only, no tenant data' },
    { method: 'PATCH', url: '/api/v1/admin/knowledge/:id', why: 'knowledge sources are super-admin-only platform config' },
    { method: 'DELETE', url: '/api/v1/admin/knowledge/:id', why: 'knowledge sources are super-admin-only platform config' },
    { method: 'POST', url: '/api/v1/admin/knowledge/:id/test', why: 'admin-only connectivity probe of a platform-level source' },
    { method: 'PATCH', url: '/api/v1/admin/agents/:id', why: 'custom specialists are super-admin-only platform config' },
    { method: 'DELETE', url: '/api/v1/admin/agents/:id', why: 'custom specialists are super-admin-only platform config' },
  ];

  const collectRoutes = async (ctx = makeContext()) => {
    const routes: { method: string; url: string }[] = [];
    const app = await buildApp(ctx, {
      onRoute: (r) => {
        for (const m of Array.isArray(r.method) ? r.method : [r.method]) routes.push({ method: m, url: r.url });
      },
    });
    await app.ready();
    return { app, routes: routes.filter((r) => !['HEAD', 'OPTIONS'].includes(r.method)) };
  };

  it('refuses every org-, client- and session-addressed route to a non-member admin', async () => {
    const ctx = makeContext();
    const { app, routes } = await collectRoutes(ctx);
    try {
      // A super admin owns the fixtures; an admin with no membership is the caller under test.
      await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'super@t.io', password: 'password12345', displayName: 'S' } });
      await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'admin@t.io', password: 'password12345', displayName: 'A' } });
      const admin = ctx.repos.users.byEmail('admin@t.io')!;
      ctx.repos.users.update(admin.id, { status: 'active', role: 'admin' });
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@t.io', password: 'password12345' } });
      const headers = { authorization: `Bearer ${login.json().token}` };

      const client = ctx.repos.clients.create({ name: 'Other', slug: 'other' });
      const org = ctx.repos.orgs.create({
        clientId: client.id,
        label: 'O',
        kind: 'sandbox',
        loginUrl: 'https://test.salesforce.com',
        apiVersion: '62.0',
        protected: false,
      });
      const superUser = ctx.repos.users.byEmail('super@t.io')!;
      const session = ctx.runtime.createSession({ userId: superUser.id, orgId: org.id, uiMode: 'visual' });
      const project = ctx.repos.projects.create({ clientId: client.id, name: 'P' });
      const task = ctx.repos.tasks.create({ projectId: project.id, title: 'T' });
      const skill = ctx.repos.skills.create({
        name: 'S',
        kind: 'knowledge',
        scope: 'client',
        clientId: client.id,
        roles: ['orchestrator'],
        content: 'x',
        updatedBy: 'test',
      } as any);
      const doc = ctx.repos.docs.create({
        sessionId: session.id,
        clientId: client.id,
        orgId: org.id,
        path: 'docs/d.md',
        title: 'D',
        markdown: 'c',
        summary: 's',
        tags: [],
      } as any);

      const fill = (url: string) => {
        const idFor = url.includes('/sessions/')
          ? session.id
          : url.includes('/projects/')
            ? project.id
            : url.includes('/tasks/')
              ? task.id
              : url.includes('/skills/')
                ? skill.id
                : client.id;
        return url
          .replace(':orgId', org.id)
          .replace(':clientId', client.id)
          .replace(':docId', doc.id)
          .replace(':logId', '07L000000000001AAA')
          .replace(':sobject', 'Account')
          .replace(':command', 'deploy')
          .replace(':userId', admin.id)
          .replace(':id', idFor);
      };

      const tenantRoutes = routes.filter(
        (r) => PARAMS.some((p) => r.url.includes(p)) && !ROUTE_ALLOWLIST.some((a) => a.method === r.method && a.url === r.url),
      );
      expect(tenantRoutes.length).toBeGreaterThan(40);

      const leaks: string[] = [];
      for (const r of tenantRoutes) {
        const res = await app.inject({
          method: r.method as any,
          url: fill(r.url),
          headers,
          payload: ['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined,
        });
        if (![403, 404].includes(res.statusCode)) leaks.push(`${r.method} ${r.url} -> ${res.statusCode}`);
      }
      expect(
        leaks,
        `Routes reachable by a non-member:\n${leaks.join('\n')}\n\nRoute them through requireClientAccess/requireOrgAccess, or add them to ROUTE_ALLOWLIST with a reason.`,
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('keeps the route allowlist honest', async () => {
    const { app, routes } = await collectRoutes();
    await app.close();
    const known = routes.map((r) => `${r.method} ${r.url}`);
    for (const a of ROUTE_ALLOWLIST) {
      expect(known, `Allowlisted route no longer exists: ${a.method} ${a.url}`).toContain(`${a.method} ${a.url}`);
      expect(a.why.length).toBeGreaterThan(10);
    }
  });
});
