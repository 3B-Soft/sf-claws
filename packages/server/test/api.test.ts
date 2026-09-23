import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { makeContext } from './helpers.js';
import { ConnectionManager } from '../src/salesforce/connection.js';

describe('http api', () => {
  let app: FastifyInstance;
  let token = '';
  let clientId = '';
  let orgId = '';
  const ctx = makeContext();
  beforeAll(async () => {
    app = await buildApp(ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const auth = () => ({ authorization: `Bearer ${token}` });

  it('reports setup required, bootstraps first user as superadmin, gates pending users', async () => {
    const h = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(h.json().setupRequired).toBe(true);
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'a@b.io', password: 'password12345', displayName: 'A' } });
    expect(r.statusCode).toBe(201);
    token = r.json().token;
    expect(r.json().user.role).toBe('superadmin');
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'c@b.io', password: 'password12345', displayName: 'C' } });
    expect(r2.json().pending).toBe(true);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'c@b.io', password: 'password12345' } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('USER_PENDING');
    const users = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: auth() });
    const pending = users.json().find((u: any) => u.email === 'c@b.io');
    const approve = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${pending.id}/approve`, headers: auth(), payload: { role: 'user' } });
    expect(approve.json().status).toBe('active');
    const login2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'c@b.io', password: 'password12345' } });
    expect(login2.statusCode).toBe(200);
    // non-admin cannot list users
    const denied = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: { authorization: `Bearer ${login2.json().token}` } });
    expect(denied.statusCode).toBe(403);
  });

  it('rejects unauthenticated api calls and bad tokens', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/clients' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/clients', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('manages clients, orgs, github config, skills and policy', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/v1/clients', headers: auth(), payload: { name: 'Acme', slug: 'acme' } });
    expect(c.statusCode).toBe(201);
    clientId = c.json().id;
    const o = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${clientId}/orgs`,
      headers: auth(),
      payload: { label: 'Prod', kind: 'production', loginUrl: 'https://login.salesforce.com', consumerKey: 'org-key', consumerSecret: 'org-secret' },
    });
    expect(o.statusCode).toBe(201);
    orgId = o.json().id;
    expect(o.json().protected).toBe(true); // production auto-protected
    expect(o.json().consumerKey).toBe('org-key');
    expect(JSON.stringify(o.json())).not.toContain('org-secret');
    // The org's own Connected App wins over the server-wide SF_CLIENT_ID.
    const oauth2 = new ConnectionManager(ctx.repos, ctx.config, ctx.secrets, ctx.log).oauth2(ctx.repos.orgs.byId(orgId)!);
    expect(oauth2.clientId).toBe('org-key');
    expect(oauth2.clientSecret).toBe('org-secret');
    const gh = await app.inject({
      method: 'PUT',
      url: `/api/v1/clients/${clientId}/github`,
      headers: auth(),
      payload: { owner: 'acme', repo: 'sfdx', commitStrategy: 'branch-per-session', token: 'ghp_secret' },
    });
    expect(gh.json().hasToken).toBe(true);
    expect(JSON.stringify(gh.json())).not.toContain('ghp_secret');
    const s = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      headers: auth(),
      payload: { name: 'Pkg', kind: 'knowledge', scope: 'client', clientId, roles: ['orchestrator'], content: '# hi' },
    });
    expect(s.statusCode).toBe(201);
    const p = await app.inject({ method: 'PUT', url: `/api/v1/admin/policy?clientId=${clientId}`, headers: auth(), payload: { minCodeCoverage: 90 } });
    // Permission rules are validated at the API, so a typo cannot be saved as a rule that silently matches nothing.
    const scoped = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/policy?clientId=${clientId}`,
      headers: auth(),
      payload: { impactAllowList: ['deploy', 'update_record(Account)'], impactDenyList: ['delete_record'] },
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().effective.impactDenyList).toEqual(['delete_record']);
    const typo = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/policy?clientId=${clientId}`,
      headers: auth(),
      payload: { impactAllowList: ['deploi'] },
    });
    expect(typo.statusCode).toBe(400);
    expect(p.json().effective.minCodeCoverage).toBe(90);
    const resolve = await app.inject({ method: 'GET', url: '/api/v1/orgs/resolve?host=acme.lightning.force.com', headers: auth() });
    expect(resolve.statusCode).toBe(404);
    ctx.repos.orgs.update(orgId, { myDomainHost: 'acme.my.salesforce.com', instanceUrl: 'https://acme.my.salesforce.com' });
    const resolve2 = await app.inject({ method: 'GET', url: '/api/v1/orgs/resolve?host=acme.lightning.force.com', headers: auth() });
    expect(resolve2.json().org.id).toBe(orgId);
    const resolve3 = await app.inject({ method: 'GET', url: '/api/v1/orgs/resolve?host=acme.my.salesforce-setup.com', headers: auth() });
    expect(resolve3.json().org.id).toBe(orgId);
  });

  it('configures browser-session clients without external-app credentials', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/clients',
      headers: auth(),
      payload: { name: 'Browser Auth', slug: 'browser-auth', salesforceAuthMode: 'browser_session' },
    });
    expect(c.statusCode).toBe(201);
    expect(c.json().salesforceAuthMode).toBe('browser_session');

    const generic = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${c.json().id}/orgs`,
      headers: auth(),
      payload: { label: 'Wrong URL', kind: 'sandbox', loginUrl: 'https://test.salesforce.com' },
    });
    expect(generic.statusCode).toBe(400);

    const org = await app.inject({
      method: 'POST',
      url: `/api/v1/clients/${c.json().id}/orgs`,
      headers: auth(),
      payload: { label: 'UAT', kind: 'sandbox', loginUrl: 'https://acme--uat.sandbox.my.salesforce.com' },
    });
    expect(org.statusCode).toBe(201);
    expect(org.json().consumerKey).toBeNull();
    expect(org.json().myDomainHost).toBe('acme--uat.sandbox.my.salesforce.com');
  });

  it('device pairing flow', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/auth/device/start' });
    const { code } = start.json();
    expect((await app.inject({ method: 'GET', url: `/api/v1/auth/device/poll?code=${code}` })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/device/approve', headers: auth(), payload: { code } })).statusCode).toBe(200);
    const poll = await app.inject({ method: 'GET', url: `/api/v1/auth/device/poll?code=${code}` });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().token).toBeTruthy();
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${poll.json().token}` } });
    expect(me.json().email).toBe('a@b.io');
    expect((await app.inject({ method: 'GET', url: `/api/v1/auth/device/poll?code=${code}` })).statusCode).toBe(404);
  });

  it('creates sessions and refuses to run against a disconnected org', async () => {
    const s = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: auth(), payload: { orgId, uiMode: 'visual' } });
    expect(s.statusCode).toBe(201);
    const m = await app.inject({ method: 'POST', url: `/api/v1/sessions/${s.json().id}/messages`, headers: auth(), payload: { text: 'hi' } });
    expect(m.statusCode).toBe(409);
    expect(m.json().error.code).toBe('ORG_DISCONNECTED');
    const hist = await app.inject({ method: 'GET', url: `/api/v1/sessions/${s.json().id}/history`, headers: auth() });
    expect(hist.json()[0].type).toBe('session.status');
  });
});
