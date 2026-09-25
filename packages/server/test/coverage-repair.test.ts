import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFile } from '@sf-claws/shared';
import { makeContext, seedClientOrgUser, FakeProvider, disablePlanMode, waitForIdle, toolCall, text } from './helpers.js';
import { normalizeDeployResult } from '../src/salesforce/service.js';
import { classifyFailure } from '../src/agents/validation-recovery.js';
import { SessionRuntime } from '../src/agents/runtime.js';
import { buildApp } from '../src/http/app.js';

const file = (name: string, content = `public class ${name} {}`): WorkspaceFile => ({
  path: `classes/${name}.cls`,
  metadataType: 'ApexClass',
  fullName: name,
  content,
  action: 'created',
  original: null,
});
const coverageResult = (warnings?: unknown) =>
  normalizeDeployResult({
    id: '0AfCoverage',
    success: false,
    status: 'Failed',
    checkOnly: true,
    numberComponentsTotal: 3,
    numberComponentErrors: 0,
    numberTestsTotal: 13,
    numberTestErrors: 0,
    details: { runTestResult: { codeCoverage: { name: 'Matcher', numLocations: 100, numLocationsNotCovered: 46 }, codeCoverageWarnings: warnings } },
  });

describe('coverage validation repair', () => {
  it('retains Salesforce warnings and raw response; handles missing warning diagnostics', () => {
    const result = coverageResult({ name: 'Matcher', message: 'Your code coverage is 53%. You need at least 75% coverage.' });
    expect(result.failures[0]).toMatchObject({ componentType: 'CodeCoverage', fullName: 'Matcher', problem: expect.stringContaining('53%') });
    expect(result.rawResult).toHaveProperty('details.runTestResult.codeCoverage');
    expect(classifyFailure(result)).toBe('coverage');
    expect(classifyFailure(coverageResult())).toBe('coverage');
  });

  it('permits new tests, preserves their companions in slices, and does not submit duplicate failures', async () => {
    const deploy = vi.fn(async () => coverageResult());
    const ctx = makeContext({ sf: { deploy } });
    try {
      const { user, org } = await seedClientOrgUser(ctx);
      const s = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
      ctx.repos.workspace.upsert(s.id, file('Matcher'));
      const run = await ctx.runtime.validate(s.id);
      expect(run.failures.some((f) => f.componentType === 'CodeCoverage')).toBe(true);
      expect(ctx.repos.compileControl.get(s.id).stopped).toBeNull();
      expect(ctx.runtime.workspaceWriteRefusal(s.id, file('MatcherTest', '@IsTest class MatcherTest {}'))).toBeNull();
      await ctx.runtime.validate(s.id);
      expect(deploy).toHaveBeenCalledTimes(1);
      await expect(ctx.runtime.validate(s.id, { agentId: 'builder' })).rejects.toThrow('unchanged payload');
      const test = file('MatcherTest', '@IsTest class MatcherTest {}');
      ctx.repos.workspace.upsert(s.id, test);
      ctx.repos.workspace.upsert(s.id, { ...test, path: test.path + '-meta.xml', content: '<ApexClass />' });
      await ctx.runtime.validate(s.id, { paths: ['classes/Matcher.cls'], testLevel: 'RunSpecifiedTests' });
      const checkpoint = ctx.repos.harness.list(s.id)[0];
      expect(checkpoint.payload.runTests).toEqual(['MatcherTest']);
      expect(checkpoint.payload.files.map((f) => f.path)).toContain('classes/MatcherTest.cls-meta.xml');
    } finally {
      ctx.db.close();
    }
  });

  it('clears a removed component root so its renamed replacement can be staged', async () => {
    const bad = normalizeDeployResult({
      success: false,
      details: { componentFailures: { componentType: 'ApexClass', fullName: 'TooLong', problem: 'Identifier name is too long' } },
    });
    const ctx = makeContext({ sf: { deploy: async () => bad } });
    try {
      const { user, org } = await seedClientOrgUser(ctx);
      const s = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
      ctx.repos.workspace.upsert(s.id, file('TooLong'));
      await ctx.runtime.validate(s.id);
      ctx.repos.workspace.remove(s.id, 'classes/TooLong.cls');
      ctx.runtime.noteWorkspaceChange(s.id, 'classes/TooLong.cls');
      expect(ctx.runtime.workspaceWriteRefusal(s.id, file('ShortTest'))).toBeNull();
    } finally {
      ctx.db.close();
    }
  });

  it('resumes a persisted legacy coverage stop and delegates test repair after runtime replacement', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { readComponent: async () => [], deploy: async () => coverageResult() } });
    try {
      disablePlanMode(ctx);
      const { user, org } = await seedClientOrgUser(ctx);
      const s = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
      ctx.repos.workspace.upsert(s.id, file('Matcher'));
      const run = await ctx.runtime.validate(s.id);
      ctx.repos.deploys.update(run.id, { failures: [] });
      const control = ctx.repos.compileControl.get(s.id);
      control.stopped = 'Salesforce unknown failure. No code repair is indicated; inspect the archived attempts and validate manually before resuming.';
      ctx.repos.compileControl.set(s.id, control);
      ctx.runtime = new SessionRuntime(ctx);
      ctx.runtime.bind(ctx);
      provider.script = [
        (req) => {
          expect(JSON.stringify(req.messages)).toContain('54');
          return toolCall('run_subagent', { role: 'general', objective: 'Repair Matcher coverage; add MatcherTest.' });
        },
        () => toolCall('write_workspace_file', { path: 'classes/MatcherTest.cls', content: '@IsTest class MatcherTest {}' }),
        () => text('Test staged; further test implementation required.'),
        () => text('Test repair started.'),
      ];
      ctx.runtime.resume(s.id, user.id);
      await waitForIdle(ctx, s.id);
      expect(ctx.repos.workspace.get(s.id, 'classes/MatcherTest.cls')).toBeTruthy();
      expect(ctx.repos.events.listAfter(s.id).some((e) => e.type === 'agent.spawned' && e.role === 'general')).toBe(true);
      expect(ctx.repos.compileControl.get(s.id).stopped).toBeNull();
    } finally {
      ctx.db.close();
    }
  });

  it('hands a manual validation failure to the agent and never deploys automatically', async () => {
    const provider = new FakeProvider([() => text('Coverage repair required.')]);
    const deploy = vi.fn(async () => coverageResult());
    const ctx = makeContext({ provider, sf: { deploy } });
    const { user, org } = await seedClientOrgUser(ctx);
    disablePlanMode(ctx);
    const s = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    ctx.repos.workspace.upsert(s.id, file('Matcher'));
    const app = await buildApp(ctx);
    try {
      const login = await ctx.auth.login('admin@test.io', 'password12345');
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${s.id}/validate`,
        headers: { authorization: `Bearer ${login.token}` },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      await waitForIdle(ctx, s.id);
      expect(JSON.stringify(provider.requests[0].messages)).toContain('Harness validation feedback');
      expect(ctx.repos.deploys.list(s.id).every((r) => r.checkOnly)).toBe(true);
      expect(ctx.repos.sessions.byId(s.id)?.status).not.toBe('running');
    } finally {
      await app.close();
      ctx.db.close();
    }
  });

  it('refuses orchestrator code writes with an actionable delegation instruction', async () => {
    const provider = new FakeProvider([
      () => toolCall('write_workspace_file', { path: 'classes/Matcher.cls', content: 'class Matcher {}' }),
      () => text('Delegate.'),
    ]);
    const ctx = makeContext({ provider });
    try {
      disablePlanMode(ctx);
      const { user, org } = await seedClientOrgUser(ctx);
      const s = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
      ctx.runtime.startTurn(s.id, user.id, 'Build matcher');
      await waitForIdle(ctx, s.id);
      expect(ctx.repos.workspace.list(s.id)).toEqual([]);
      expect(JSON.stringify(ctx.repos.events.listAfter(s.id))).toContain('Implementation must be delegated');
    } finally {
      ctx.db.close();
    }
  });
});
