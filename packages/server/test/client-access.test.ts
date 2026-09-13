import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { makeContext } from './helpers.js';

/**
 * Client membership through the per-user admin route: a user sees only the clients they were made
 * a member of. The super admin (the first registered account) belongs to every client and is the
 * only role that may change membership; `membership.test.ts` covers the per-client routes.
 */
describe('client access', () => {
  let app: FastifyInstance;
  const ctx = makeContext();
  let adminToken = '';
  let userToken = '';
  let userId = '';
  const mine = { id: '', orgId: '' };
  const theirs = { id: '', orgId: '' };

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const get = (url: string, token: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: bearer(token) });

  beforeAll(async () => {
    app = await buildApp(ctx);
    await app.ready();
    const admin = await ctx.auth.register({ email: 'boss@test.io', password: 'password12345', displayName: 'Boss' });
    adminToken = admin.token!;
    const consultant = await ctx.auth.register({ email: 'dev@test.io', password: 'password12345', displayName: 'Dev' });
    userId = consultant.user.id;
    ctx.repos.users.update(userId, { status: 'active', role: 'user' });
    userToken = (await ctx.auth.login('dev@test.io', 'password12345')).token;

    for (const [slug, target] of [
      ['acme', mine],
      ['globex', theirs],
    ] as const) {
      const c = ctx.repos.clients.create({ name: slug, slug });
      const org = ctx.repos.orgs.create({
        clientId: c.id,
        label: `${slug} UAT`,
        kind: 'sandbox',
        loginUrl: 'https://test.salesforce.com',
        apiVersion: '62.0',
        protected: false,
      });
      target.id = c.id;
      target.orgId = org.id;
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('hides every client from a consultant with no membership', async () => {
    expect((await get('/clients', userToken)).json()).toEqual([]);
    expect((await get('/orgs', userToken)).json()).toEqual([]);
    expect((await get(`/clients/${mine.id}`, userToken)).statusCode).toBe(403);
    expect((await get(`/orgs/${mine.orgId}`, userToken)).statusCode).toBe(403);
  });

  it('lets the super admin assign a client, and then only that client is visible', async () => {
    const assign = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${userId}/clients`,
      headers: bearer(adminToken),
      payload: { clientIds: [mine.id] },
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().clientIds).toEqual([mine.id]);

    expect((await get('/clients', userToken)).json().map((c: any) => c.id)).toEqual([mine.id]);
    expect((await get('/orgs', userToken)).json().map((o: any) => o.id)).toEqual([mine.orgId]);
    expect((await get(`/clients/${mine.id}`, userToken)).statusCode).toBe(200);
    expect((await get(`/orgs/${mine.orgId}`, userToken)).statusCode).toBe(200);

    // The client they are not a member of stays closed, by client id and by org id.
    expect((await get(`/clients/${theirs.id}`, userToken)).statusCode).toBe(403);
    expect((await get(`/orgs/${theirs.orgId}`, userToken)).statusCode).toBe(403);
    expect((await get(`/clients/${theirs.id}/orgs`, userToken)).statusCode).toBe(403);
    expect((await get(`/clients/${theirs.id}/github/tree`, userToken)).statusCode).toBe(403);
    expect((await get(`/orgs/${theirs.orgId}/logs`, userToken)).statusCode).toBe(403);
    expect((await get(`/admin/policy?clientId=${theirs.id}`, userToken)).statusCode).toBe(403);
    expect((await get(`/skills?clientId=${theirs.id}`, userToken)).statusCode).toBe(403);
    // The unfiltered skill list is global skills plus the caller's own clients', never another client's.
    const skills = await get('/skills', userToken);
    expect(skills.statusCode).toBe(200);
    expect(skills.json().every((s: any) => s.scope === 'global' || s.clientId === mine.id)).toBe(true);
  });

  it('refuses a session on another client org, and allows one on an assigned org', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: bearer(userToken),
      payload: { orgId: theirs.orgId, uiMode: 'visual' },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: bearer(userToken),
      payload: { orgId: mine.orgId, uiMode: 'visual' },
    });
    expect(ok.statusCode).toBe(201);

    // A session on a client the consultant was never given cannot be opened either.
    const foreign = ctx.runtime.createSession({ userId, orgId: theirs.orgId, uiMode: 'visual' });
    expect((await get(`/sessions/${foreign.id}`, userToken)).statusCode).toBe(403);
  });

  it('still shows the super admin every client and org', async () => {
    expect((await get('/clients', adminToken)).json()).toHaveLength(2);
    expect((await get('/orgs', adminToken)).json()).toHaveLength(2);
    expect((await get(`/clients/${theirs.id}`, adminToken)).statusCode).toBe(200);
    expect((await get(`/orgs/${theirs.orgId}`, adminToken)).statusCode).toBe(200);
  });

  it('refuses to assign clients to the super admin, who already belongs to them all', async () => {
    const admin = ctx.repos.users.list().find((u) => u.email === 'boss@test.io')!;
    const r = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${admin.id}/clients`,
      headers: bearer(adminToken),
      payload: { clientIds: [mine.id] },
    });
    expect(r.statusCode).toBe(400);
    expect((await get(`/admin/users/${admin.id}/clients`, adminToken)).json().seesAllClients).toBe(true);
  });

  it('removes access when the membership is taken away', async () => {
    await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${userId}/clients`, headers: bearer(adminToken), payload: { clientIds: [] } });
    expect((await get('/clients', userToken)).json()).toEqual([]);
    expect((await get(`/orgs/${mine.orgId}`, userToken)).statusCode).toBe(403);
  });
});
