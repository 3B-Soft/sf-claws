import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { makeContext, seedClientOrgUser } from './helpers.js';
import JSZip from 'jszip';
import { normalizeDeployResult } from '../src/salesforce/service.js';
import { auditData } from '../src/lib/audit-data.js';

describe('lossless session export', () => {
  it('downloads staged source/originals and admin evidence with exact validation payloads, scoped to the session', async () => {
    const ctx = makeContext({
      sf: {
        deploy: async () =>
          normalizeDeployResult({
            id: '0AfExample',
            success: false,
            status: 'Failed',
            checkOnly: true,
            details: { runTestResult: { codeCoverageWarnings: { message: 'Code coverage is 53%; 75% required.' } } },
          }),
      },
    });
    const { user, org, client } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    ctx.repos.workspace.upsert(session.id, {
      path: 'classes/Matcher.cls',
      content: 'class Matcher {}',
      original: 'class Matcher { /* old */ }',
      action: 'modified',
      metadataType: 'ApexClass',
      fullName: 'Matcher',
    });
    ctx.repos.workspace.upsert(session.id, {
      path: '__destructive__/ApexClass/Old',
      content: '',
      original: null,
      action: 'deleted',
      metadataType: 'ApexClass',
      fullName: 'Old',
    });
    ctx.repos.audit.log({ action: 'agent.tool.call', target: session.id, details: { input: 'long evidence'.repeat(3000) } });
    ctx.repos.audit.log({ action: 'other.session', target: 'elsewhere', details: { marker: 'DO_NOT_EXPORT' } });
    const run = await ctx.runtime.validate(session.id);
    const app = await buildApp(ctx);
    try {
      const login = await ctx.auth.login('admin@test.io', 'password12345');
      const headers = { authorization: `Bearer ${login.token}` };
      const archive = await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/workspace/export`, headers });
      expect(archive.statusCode).toBe(200);
      expect(archive.headers['content-type']).toContain('application/zip');
      const zip = await JSZip.loadAsync(archive.rawPayload);
      expect(await zip.file('source/classes/Matcher.cls')!.async('string')).toBe('class Matcher {}');
      expect(await zip.file('originals/classes/Matcher.cls')!.async('string')).toContain('old');
      expect(zip.file('source/__destructive__/ApexClass/Old')).toBeNull();
      expect(await zip.file('workspace.json')!.async('string')).toContain('deleted');
      const details = await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/deploys/${run.id}/export`, headers });
      expect(details.json().checkpoints[0].checkpoint.payload.files[0].content).toBe('class Matcher {}');
      expect(details.json().checkpoints[0].attempts[0].outcome.rawResult.id).toBe('0AfExample');
      const audit = await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/audit/export`, headers });
      expect(audit.statusCode).toBe(200);
      const auditZip = await JSZip.loadAsync(audit.rawPayload);
      const ledger = await auditZip.file('audit.json')!.async('string');
      expect(ledger).toContain('long evidence'.repeat(3000));
      expect(ledger).not.toContain('DO_NOT_EXPORT');
      expect(await auditZip.file('validations.json')!.async('string')).toContain('Code coverage is 53%');
      expect(await auditZip.file('manifest.json')!.async('string')).toContain('cannot be reconstructed');
      // The session owner can export source, but audit evidence requires an admin.
      ctx.repos.users.update(user.id, { role: 'user' });
      ctx.repos.clientMembers.set(user.id, client.id, 'member');
      expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/audit/export`, headers })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/workspace/export`, headers })).statusCode).toBe(200);
      ctx.repos.clientMembers.remove(user.id, client.id);
      for (const path of ['workspace/export', 'audit/export', `deploys/${run.id}/export`])
        expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${session.id}/${path}`, headers })).statusCode).toBe(403);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });

  it('excludes private provider blocks and structured credentials from audit evidence', () => {
    expect(
      auditData({
        raw: { secret: 'opaque' },
        authorization: 'bearer secret',
        content: [
          { type: 'thinking', text: 'private' },
          { type: 'text', text: 'Observable decision' },
        ],
      }),
    ).toEqual({ authorization: '[REDACTED]', content: [{ type: 'text', text: 'Observable decision' }] });
  });

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
