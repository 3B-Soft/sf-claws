import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { makeContext } from './helpers.js';

/**
 * Client membership: who may see which client. The rule under test is the one docs/TENANCY.md
 * states: a super admin belongs to every client, everyone else (platform admins included) only to
 * the clients they were added to.
 */
describe('client membership', () => {
  let app: FastifyInstance;
  let superToken = '';
  let adminToken = '';
  let userToken = '';
  let adminId = '';
  let userId = '';
  let acme = '';
  let globex = '';
  let acmeOrg = '';
  let globexOrg = '';
  const ctx = makeContext();
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await buildApp(ctx);
    await app.ready();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'super@t.io', password: 'password12345', displayName: 'Super' },
    });
    superToken = first.json().token;
    for (const [email, role] of [
      ['admin@t.io', 'admin'],
      ['user@t.io', 'user'],
    ] as const) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password12345', displayName: email } });
      const pending = ctx.repos.users.byEmail(email)!;
      await app.inject({ method: 'POST', url: `/api/v1/admin/users/${pending.id}/approve`, headers: bearer(superToken), payload: { role } });
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'password12345' } });
      if (role === 'admin') {
        adminToken = login.json().token;
        adminId = pending.id;
      } else {
        userToken = login.json().token;
        userId = pending.id;
      }
    }
    acme = ctx.repos.clients.create({ name: 'Acme', slug: 'acme' }).id;
    globex = ctx.repos.clients.create({ name: 'Globex', slug: 'globex' }).id;
    const org = (clientId: string, label: string) =>
      ctx.repos.orgs.create({ clientId, label, kind: 'sandbox', loginUrl: 'https://test.salesforce.com', apiVersion: '62.0', protected: false }).id;
    acmeOrg = org(acme, 'Acme UAT');
    globexOrg = org(globex, 'Globex UAT');
  });
  afterAll(async () => {
    await app.close();
  });

  it('shows a super admin every client and a fresh user none', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/v1/clients', headers: bearer(superToken) });
    expect(
      all
        .json()
        .map((c: { slug: string }) => c.slug)
        .sort(),
    ).toEqual(['acme', 'globex']);
    const none = await app.inject({ method: 'GET', url: '/api/v1/clients', headers: bearer(userToken) });
    expect(none.json()).toEqual([]);
    const orgs = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: bearer(adminToken) });
    expect(orgs.json()).toEqual([]);
  });

  it('lets only a super admin add and remove members', async () => {
    const denied = await app.inject({ method: 'PUT', url: `/api/v1/clients/${acme}/members/${userId}`, headers: bearer(adminToken), payload: {} });
    expect(denied.statusCode).toBe(403);
    const added = await app.inject({ method: 'PUT', url: `/api/v1/clients/${acme}/members/${userId}`, headers: bearer(superToken), payload: {} });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ userId, clientId: acme, role: 'member', email: 'user@t.io' });
    const asAdmin = await app.inject({
      method: 'PUT',
      url: `/api/v1/clients/${acme}/members/${adminId}`,
      headers: bearer(superToken),
      payload: { role: 'admin' },
    });
    expect(asAdmin.json().role).toBe('admin');
    const list = await app.inject({ method: 'GET', url: `/api/v1/clients/${acme}/members`, headers: bearer(userToken) });
    expect(
      list
        .json()
        .map((m: { userId: string }) => m.userId)
        .sort(),
    ).toEqual([adminId, userId].sort());
    const inventory = await app.inject({ method: 'GET', url: '/api/v1/admin/memberships', headers: bearer(superToken) });
    expect(inventory.json()).toHaveLength(2);
    expect(inventory.json()[0].clientName).toBe('Acme');
  });

  it('refuses to add a super admin, who belongs everywhere already', async () => {
    const superId = ctx.repos.users.byEmail('super@t.io')!.id;
    const res = await app.inject({ method: 'PUT', url: `/api/v1/clients/${acme}/members/${superId}`, headers: bearer(superToken), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('scopes listings to the clients the caller belongs to', async () => {
    const clients = await app.inject({ method: 'GET', url: '/api/v1/clients', headers: bearer(userToken) });
    expect(clients.json().map((c: { id: string }) => c.id)).toEqual([acme]);
    const orgs = await app.inject({ method: 'GET', url: '/api/v1/orgs', headers: bearer(userToken) });
    expect(orgs.json().map((o: { id: string }) => o.id)).toEqual([acmeOrg]);
    const resolveOwn = await app.inject({ method: 'GET', url: `/api/v1/orgs/resolve?sfOrgId=00D000000000001AAA`, headers: bearer(userToken) });
    expect(resolveOwn.statusCode).toBe(404);
  });

  it('answers a non-member the same for a foreign client as for one that does not exist', async () => {
    const foreign = await app.inject({ method: 'GET', url: `/api/v1/clients/${globex}`, headers: bearer(userToken) });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('NOT_A_MEMBER');
    const foreignOrg = await app.inject({ method: 'GET', url: `/api/v1/orgs/${globexOrg}`, headers: bearer(adminToken) });
    expect(foreignOrg.statusCode).toBe(403);
    const policy = await app.inject({ method: 'GET', url: `/api/v1/admin/policy?clientId=${globex}`, headers: bearer(userToken) });
    expect(policy.statusCode).toBe(403);
    const ownPolicy = await app.inject({ method: 'GET', url: `/api/v1/admin/policy?clientId=${acme}`, headers: bearer(userToken) });
    expect(ownPolicy.statusCode).toBe(200);
    const globalPolicy = await app.inject({ method: 'GET', url: '/api/v1/admin/policy', headers: bearer(userToken) });
    expect(globalPolicy.statusCode).toBe(200);
  });

  it('refuses to create a session against an org of a client the caller is not in', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: bearer(userToken), payload: { orgId: globexOrg, uiMode: 'visual' } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: bearer(userToken), payload: { orgId: acmeOrg, uiMode: 'visual' } });
    expect(ok.statusCode).toBe(201);
  });

  it('lets a client admin see every session of that client, and revokes access with the membership', async () => {
    const mine = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: bearer(userToken), payload: { orgId: acmeOrg, uiMode: 'visual' } });
    const id = mine.json().id;
    // The platform admin is an Acme member with the client admin role: sees the user's session.
    expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${id}`, headers: bearer(adminToken) })).statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: bearer(adminToken) });
    expect(listed.json().some((s: { id: string }) => s.id === id)).toBe(true);
    // Removing the membership closes the door, ownership notwithstanding.
    await app.inject({ method: 'DELETE', url: `/api/v1/clients/${acme}/members/${userId}`, headers: bearer(superToken) });
    expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${id}`, headers: bearer(userToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: bearer(userToken) })).json()).toEqual([]);
    const gone = await app.inject({ method: 'DELETE', url: `/api/v1/clients/${acme}/members/${userId}`, headers: bearer(superToken) });
    expect(gone.statusCode).toBe(404);
  });

  it('shows client-scoped skills only to members, global skills to everyone', async () => {
    ctx.repos.clientMembers.set(userId, acme, 'member');
    ctx.repos.skills.create({ name: 'Global', kind: 'knowledge', scope: 'global', roles: ['orchestrator'], content: 'g', updatedBy: 'test' } as any);
    const acmeSkill = ctx.repos.skills.create({
      name: 'Acme only',
      kind: 'knowledge',
      scope: 'client',
      clientId: acme,
      roles: ['orchestrator'],
      content: 'a',
      updatedBy: 'test',
    } as any);
    const globexSkill = ctx.repos.skills.create({
      name: 'Globex only',
      kind: 'knowledge',
      scope: 'client',
      clientId: globex,
      roles: ['orchestrator'],
      content: 'x',
      updatedBy: 'test',
    } as any);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: bearer(userToken) });
    const names = listed.json().map((s: { name: string }) => s.name);
    expect(names).toContain('Global');
    expect(names).toContain('Acme only');
    expect(names).not.toContain('Globex only');
    expect((await app.inject({ method: 'GET', url: `/api/v1/skills/${acmeSkill.id}`, headers: bearer(userToken) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/skills/${globexSkill.id}`, headers: bearer(userToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/skills?clientId=${globex}`, headers: bearer(userToken) })).statusCode).toBe(403);
    const everything = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: bearer(superToken) });
    expect(everything.json().map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['Global', 'Acme only', 'Globex only']));
  });

  it('gives the admin who creates a client a membership of it', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/clients', headers: bearer(adminToken), payload: { name: 'Initech', slug: 'initech' } });
    expect(created.statusCode).toBe(201);
    expect(ctx.repos.clientMembers.get(adminId, created.json().id)?.role).toBe('admin');
  });
});
