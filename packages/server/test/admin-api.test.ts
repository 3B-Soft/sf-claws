import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { makeContext } from './helpers.js';

/**
 * The admin surface added for knowledge sources, per-user provider keys and observability.
 * These tests exist mostly to pin the authorization boundaries: a knowledge source carries a
 * credential and is readable by every session in scope, so who may create one matters.
 */
describe('admin api', () => {
  let app: FastifyInstance;
  let superToken = '';
  let adminToken = '';
  let userToken = '';
  let clientId = '';
  const ctx = makeContext({ githubToken: 'shared-github-secret' });

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
      const users = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(superToken) });
      const pending = users.json().find((u: { email: string }) => u.email === email);
      await app.inject({ method: 'POST', url: `/api/v1/admin/users/${pending.id}/approve`, headers: bearer(superToken), payload: { role } });
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'password12345' } });
      if (role === 'admin') adminToken = login.json().token;
      else userToken = login.json().token;
    }

    const client = await app.inject({ method: 'POST', url: '/api/v1/clients', headers: bearer(superToken), payload: { name: 'Acme', slug: 'acme' } });
    clientId = client.json().id;
  });
  afterAll(async () => {
    await app.close();
  });

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  describe('policy writes', () => {
    it('leaves settings the caller did not send alone', async () => {
      // A partial PUT used to replace the whole rules object, so the console's own save — which
      // never sent the spend ceilings — silently reset them to 0, meaning unlimited.
      await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/policy',
        headers: bearer(superToken),
        payload: { maxSessionCostUsd: 25, requirePlanApproval: 'always' },
      });
      const after = await app.inject({ method: 'PUT', url: '/api/v1/admin/policy', headers: bearer(superToken), payload: { minCodeCoverage: 80 } });
      const rules = after.json().effective;
      expect(rules.minCodeCoverage).toBe(80);
      expect(rules.maxSessionCostUsd).toBe(25);
      expect(rules.requirePlanApproval).toBe('always');
    });

    it('still clears a setting that is sent explicitly', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/admin/policy', headers: bearer(superToken), payload: { maxSessionCostUsd: 0 } });
      expect(res.json().effective.maxSessionCostUsd).toBe(0);
    });
  });

  describe('knowledge sources', () => {
    let sourceId = '';

    it('lets a super admin create a source and never returns the token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/knowledge',
        headers: bearer(superToken),
        payload: { kind: 'docs', name: 'Product docs', repoRef: 'acme/docs#main', guidance: 'How our products work', scope: 'global', token: 'ghp_secret' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      sourceId = body.id;
      expect(body.hasToken).toBe(true);
      expect(JSON.stringify(body)).not.toContain('ghp_secret');
      expect(JSON.stringify(body)).not.toContain('tokenEnc');
    });

    it('reports the shared token on create, list and update without storing or exposing it', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/knowledge',
        headers: bearer(superToken),
        payload: { kind: 'repo', name: 'Shared token source', repoRef: 'acme/shared', scope: 'global' },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().hasToken).toBe(true);
      const id = created.json().id;
      expect(ctx.repos.knowledge.byId(id)?.tokenEnc).toBeNull();
      const listed = await app.inject({ method: 'GET', url: '/api/v1/admin/knowledge', headers: bearer(superToken) });
      expect(listed.json().find((s: { id: string }) => s.id === id).hasToken).toBe(true);
      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/knowledge/${id}`,
        headers: bearer(superToken),
        payload: { guidance: 'Updated' },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().hasToken).toBe(true);
      for (const response of [created, listed, updated]) {
        expect(response.body).not.toContain('shared-github-secret');
        expect(response.body).not.toContain('tokenEnc');
      }
    });

    it('stores the token encrypted rather than in the clear', () => {
      const row = ctx.repos.knowledge.byId(sourceId)!;
      expect(row.tokenEnc).toBeTruthy();
      expect(row.tokenEnc).not.toContain('ghp_secret');
      expect(ctx.secrets.decrypt(row.tokenEnc!)).toBe('ghp_secret');
    });

    it('refuses creation by an admin who is not a super admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/knowledge',
        headers: bearer(adminToken),
        payload: { kind: 'repo', name: 'Sneaky', repoRef: 'acme/other', scope: 'global' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('refuses a malformed repository reference', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/knowledge',
        headers: bearer(superToken),
        payload: { kind: 'repo', name: 'Bad', repoRef: 'https://github.com/acme/thing', scope: 'global' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('requires a clientId for a client-scoped source', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/knowledge',
        headers: bearer(superToken),
        payload: { kind: 'repo', name: 'Scoped', repoRef: 'acme/thing', scope: 'client' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('keeps the existing token when an update omits it', async () => {
      const before = ctx.repos.knowledge.byId(sourceId)!.tokenEnc;
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/knowledge/${sourceId}`,
        headers: bearer(superToken),
        payload: { guidance: 'Updated' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().guidance).toBe('Updated');
      expect(ctx.repos.knowledge.byId(sourceId)!.tokenEnc).toBe(before);
    });

    it('lets an ordinary user reach none of it', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/admin/knowledge', headers: bearer(userToken) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/knowledge/${sourceId}`, headers: bearer(userToken) })).statusCode).toBe(403);
    });
  });

  describe('per-user provider keys', () => {
    it('reports whether a user has their own key and whether a platform key exists', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/me/providers', headers: bearer(userToken) });
      expect(res.statusCode).toBe(200);
      const anthropic = res.json().find((p: { provider: string }) => p.provider === 'anthropic');
      expect(anthropic.hasKey).toBe(false);
      expect(anthropic.platformFallback).toBe(true);
      expect(JSON.stringify(res.json())).not.toContain('sk-');
    });

    it('lets a user set and clear their own key without touching anyone else', async () => {
      const set = await app.inject({ method: 'PUT', url: '/api/v1/me/providers/anthropic', headers: bearer(userToken), payload: { apiKey: 'sk-user-key' } });
      expect(set.statusCode).toBe(200);

      const mine = await app.inject({ method: 'GET', url: '/api/v1/me/providers', headers: bearer(userToken) });
      expect(mine.json().find((p: { provider: string }) => p.provider === 'anthropic').hasKey).toBe(true);
      // Another user is unaffected — a per-user key must not leak across accounts.
      const theirs = await app.inject({ method: 'GET', url: '/api/v1/me/providers', headers: bearer(adminToken) });
      expect(theirs.json().find((p: { provider: string }) => p.provider === 'anthropic').hasKey).toBe(false);

      await app.inject({ method: 'DELETE', url: '/api/v1/me/providers/anthropic', headers: bearer(userToken) });
      const after = await app.inject({ method: 'GET', url: '/api/v1/me/providers', headers: bearer(userToken) });
      expect(after.json().find((p: { provider: string }) => p.provider === 'anthropic').hasKey).toBe(false);
    });

    it('needs authentication', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/me/providers' })).statusCode).toBe(401);
    });
  });

  describe('custom specialists', () => {
    let agentId = '';

    it('lets a super admin define a specialist on a delegatable base role', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/agents',
        headers: bearer(superToken),
        payload: {
          name: 'CPQ specialist',
          whenToUse: 'Anything touching quote or pricing configuration',
          baseRole: 'metadata_builder',
          instructions: 'Always check the price rule order before changing a bundle.',
          scope: 'global',
        },
      });
      expect(res.statusCode).toBe(200);
      agentId = res.json().id;
      expect(res.json().baseRole).toBe('metadata_builder');
    });

    it('refuses a base role that cannot be delegated to', async () => {
      for (const baseRole of ['orchestrator', 'summarizer']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/agents',
          headers: bearer(superToken),
          payload: { name: `Bad ${baseRole}`, whenToUse: 'x', baseRole, instructions: 'x', scope: 'global' },
        });
        expect(res.statusCode, baseRole).toBe(400);
      }
    });

    it('refuses definition by an admin who is not a super admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/agents',
        headers: bearer(adminToken),
        payload: { name: 'Sneaky', whenToUse: 'x', baseRole: 'analyst', instructions: 'x', scope: 'global' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('scopes a client specialist to that client only', async () => {
      const other = ctx.repos.clients.create({ name: 'Globex', slug: 'globex' });
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/agents',
        headers: bearer(superToken),
        payload: { name: 'Acme only', whenToUse: 'Acme conventions', baseRole: 'analyst', instructions: 'Follow Acme naming.', scope: 'client', clientId },
      });
      expect(ctx.repos.customAgents.forClient(clientId).map((a) => a.name)).toContain('Acme only');
      expect(ctx.repos.customAgents.forClient(other.id).map((a) => a.name)).not.toContain('Acme only');
      // The global specialist is still shared with everyone.
      expect(ctx.repos.customAgents.forClient(other.id).map((a) => a.name)).toContain('CPQ specialist');
    });

    it('resolves by name or id, and not at all for an unknown one', () => {
      expect(ctx.repos.customAgents.resolve(clientId, 'CPQ specialist')?.id).toBe(agentId);
      expect(ctx.repos.customAgents.resolve(clientId, agentId)?.name).toBe('CPQ specialist');
      expect(ctx.repos.customAgents.resolve(clientId, 'nonexistent')).toBeUndefined();
    });
  });

  describe('observability', () => {
    it('summarises per-tool telemetry over a window', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/tools/summary', headers: bearer(adminToken) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('tools');
      expect(Array.isArray(res.json().tools)).toBe(true);
    });

    it('reports budget per client, distinguishing "no ceiling" from "nothing used"', async () => {
      // An admin who is not a member of Acme does not see Acme's spend; a member does.
      const outsider = await app.inject({ method: 'GET', url: '/api/v1/admin/budget', headers: bearer(adminToken) });
      expect(outsider.json().find((b: { clientId: string }) => b.clientId === clientId)).toBeUndefined();
      const adminId = ctx.repos.users.byEmail('admin@t.io')!.id;
      ctx.repos.clientMembers.set(adminId, clientId, 'member');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/budget', headers: bearer(adminToken) });
      expect(res.statusCode).toBe(200);
      const acme = res.json().find((b: { clientId: string }) => b.clientId === clientId);
      expect(acme.spentThisMonth).toBe(0);
      // Unlimited must be null, not 0% — a full bar and no bar mean opposite things to an operator.
      expect(acme.percentUsed).toBeNull();

      ctx.repos.policies.set(`client:${clientId}`, { maxClientMonthlyCostUsd: 100 }, 'test');
      // Spend has to hang off a real session: usage_records is foreign-keyed to it.
      const org = ctx.repos.orgs.create({
        clientId,
        label: 'Acme UAT',
        kind: 'sandbox',
        loginUrl: 'https://test.salesforce.com',
        apiVersion: '62.0',
        protected: false,
      });
      const superUser = ctx.repos.users.list().find((u) => u.role === 'superadmin')!;
      const session = ctx.repos.sessions.create({ userId: superUser.id, clientId, orgId: org.id, title: 'spend', uiMode: 'visual' });
      ctx.repos.usage.add({
        sessionId: session.id,
        userId: superUser.id,
        clientId,
        role: 'orchestrator',
        provider: 'anthropic',
        modelId: 'm',
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 25,
        durationMs: 1,
      });
      const after = await app.inject({ method: 'GET', url: '/api/v1/admin/budget', headers: bearer(adminToken) });
      const updated = after.json().find((b: { clientId: string }) => b.clientId === clientId);
      expect(updated.spentThisMonth).toBe(25);
      expect(updated.percentUsed).toBe(25);
    });

    it('is closed to ordinary users', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/admin/budget', headers: bearer(userToken) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/v1/admin/tools/summary', headers: bearer(userToken) })).statusCode).toBe(403);
    });
  });
});
