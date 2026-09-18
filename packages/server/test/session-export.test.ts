import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { makeContext, seedClientOrgUser } from './helpers.js';

describe('lossless session export', () => {
  it('exports nested events beyond a history page, with a stable watermark and authorization', async () => {
    const ctx = makeContext();
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    for (let i = 0; i < 5010; i++)
      ctx.runtime.bus.emit(session.id, {
        type: 'tool.result',
        agentId: 'worker',
        role: 'analyst',
        toolCallId: `t${i}`,
        tool: 'describe_sobject',
        ok: true,
        label: 'Describe',
        output: { nested: { fields: [{ name: 'A__c', value: 'line one\nline two' }] } },
        durationMs: 5,
      });
    const app = await buildApp(ctx);
    try {
      const denied = await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/export` });
      expect(denied.statusCode).toBe(401);
      const login = await ctx.auth.login('admin@test.io', 'password12345');
      const headers = { authorization: `Bearer ${login.token}` };
      const response = await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/export`, headers });
      expect(response.statusCode).toBe(200);
      const [manifest, ...events] = response.body
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(manifest).toMatchObject({ type: 'export.manifest', version: 1, sessionId: session.id });
      expect(events).toHaveLength(5011);
      expect(events.at(-1).seq).toBe(manifest.throughSeq);
      expect(events.at(-1).output.nested.fields[0].value).toBe('line one\nline two');
      ctx.runtime.bus.emit(session.id, { type: 'session.status', status: 'idle', message: 'later' });
      const second = await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/history?after=5000&through=${manifest.throughSeq}`, headers });
      expect(second.json()).toHaveLength(11);
      expect(second.json().at(-1).seq).toBe(manifest.throughSeq);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });
});
