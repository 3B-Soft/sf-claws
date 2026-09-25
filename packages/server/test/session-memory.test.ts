import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, disablePlanMode, FakeProvider, text, toolCall, waitForIdle } from './helpers.js';
import { buildApp } from '../src/http/app.js';

describe('session memory exclusion', () => {
  it('excludes documentation from prompts, search and fallback while preserving human access and allowing restoration', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider });
    disablePlanMode(ctx);
    const { user, client, org } = await seedClientOrgUser(ctx);
    const past = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual', title: 'Past' });
    const doc = ctx.repos.docs.create({
      sessionId: past.id,
      clientId: client.id,
      orgId: org.id,
      path: 'past.md',
      title: 'Misleading zebra decision',
      summary: 'Misleading zebra decision',
      markdown: 'Misleading zebra decision',
      tags: [],
      committedSha: null,
    });
    expect(past.excludedFromMemory).toBe(false);
    expect(ctx.repos.docs.search(org.id, 'zebra').map((d) => d.id)).toContain(doc.id);
    ctx.repos.sessions.update(past.id, { excludedFromMemory: true });
    expect(ctx.repos.sessions.byId(past.id)?.excludedFromMemory).toBe(true);
    expect(ctx.repos.docs.memoryByOrg(org.id)).toEqual([]);
    expect(ctx.repos.docs.search(org.id, 'zebra')).toEqual([]);
    expect(ctx.repos.docs.search(org.id, '!?')).toEqual([]);
    expect(ctx.repos.docs.byOrg(org.id)).toHaveLength(1);
    expect(ctx.repos.docs.bySession(past.id)).toHaveLength(1);
    expect(ctx.repos.docs.byId(doc.id)).toEqual(doc);
    const current = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual', title: 'Current' });
    provider.script = [
      (req) => {
        expect(req.system).not.toContain('Misleading zebra');
        return toolCall('search_memory', { query: 'zebra' });
      },
      (req) => {
        expect(JSON.stringify(req.messages.at(-1))).not.toContain('Misleading zebra');
        return text('Done');
      },
    ];
    ctx.runtime.startTurn(current.id, user.id, 'Look for previous decisions');
    await waitForIdle(ctx, current.id);
    expect(provider.script).toHaveLength(0);
    // A broken FTS index must not make the fallback reveal excluded documents.
    ctx.db.exec('DROP TABLE docs_fts');
    expect(ctx.repos.docs.search(org.id, 'zebra')).toEqual([]);
    ctx.repos.sessions.update(past.id, { excludedFromMemory: false });
    expect(ctx.repos.docs.memoryByOrg(org.id).map((d) => d.id)).toContain(doc.id);
    expect(ctx.repos.docs.search(org.id, 'zebra').map((d) => d.id)).toContain(doc.id);
  });

  it('validates the API flag and enforces session access', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual', title: 'Past' });
    const app = await buildApp(ctx);
    const { token } = await ctx.auth.issueToken(user, 'web');
    const url = `/api/v1/sessions/${session.id}`;
    const headers = { authorization: `Bearer ${token}` };
    try {
      expect((await app.inject({ method: 'PATCH', url, payload: { excludedFromMemory: true } })).statusCode).toBe(401);
      const other = await ctx.auth.register({ email: 'other@test.io', password: 'password12345', displayName: 'Other' });
      ctx.repos.users.update(other.user.id, { status: 'active' });
      const otherToken = await ctx.auth.issueToken(ctx.repos.users.byId(other.user.id)!, 'web');
      expect(
        (await app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${otherToken.token}` }, payload: { excludedFromMemory: true } }))
          .statusCode,
      ).toBe(403);
      expect((await app.inject({ method: 'PATCH', url, headers, payload: { excludedFromMemory: 'true' } })).statusCode).toBe(400);
      for (const excludedFromMemory of [true, false]) {
        const response = await app.inject({ method: 'PATCH', url, headers, payload: { excludedFromMemory } });
        expect(response.statusCode).toBe(200);
        expect(response.json().excludedFromMemory).toBe(excludedFromMemory);
        expect((await app.inject({ method: 'GET', url, headers })).json().session.excludedFromMemory).toBe(excludedFromMemory);
      }
    } finally {
      await app.close();
    }
  });
});
