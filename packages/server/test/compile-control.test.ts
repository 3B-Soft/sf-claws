import { describe, expect, it, vi } from 'vitest';
import type { DeployFailure, WorkspaceFile } from '@sf-claws/shared';
import { applyCompileResult, compileDue, compileSlice, initialCompileState, missingCompanions, rootDiagnostics } from '../src/agents/compile-control.js';
import { createRepos } from '../src/db/repos/index.js';
import { makeContext, seedClientOrgUser, FakeProvider, disablePlanMode, text, waitForIdle } from './helpers.js';
import type { DeployOutcome } from '../src/salesforce/service.js';

const file = (name: string, content = `public class ${name} {}`): WorkspaceFile => ({
  path: `classes/${name}.cls`,
  content,
  original: null,
  action: 'created',
  metadataType: 'ApexClass',
  fullName: name,
});
const failure = (name: string, problem = 'Unexpected token'): DeployFailure => ({
  componentType: 'ApexClass',
  fullName: name,
  fileName: `classes/${name}.cls`,
  problem,
  problemType: 'Error',
  lineNumber: 1,
  columnNumber: 1,
});
const outcome = (failures: DeployFailure[] = []): DeployOutcome => ({
  ok: !failures.length,
  sfDeployId: 'test',
  status: failures.length ? 'Failed' : 'Succeeded',
  checkOnly: true,
  componentsTotal: 1,
  componentsDeployed: 0,
  componentsFailed: failures.length,
  testsTotal: 0,
  testsFailed: 0,
  codeCoverage: null,
  failures,
  testFailures: [],
  coverageWarnings: [],
  errorMessage: null,
});

describe('compile controller', () => {
  it('forces a compile after ten minutes even while a model call is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    class WaitingProvider extends FakeProvider {
      override async complete(req: Parameters<FakeProvider['complete']>[0]) {
        await gate;
        return super.complete(req);
      }
    }
    let calls = 0;
    const ctx = makeContext({
      provider: new WaitingProvider([() => text('Done')]),
      sf: {
        deploy: async () => {
          calls++;
          return outcome();
        },
      },
    });
    try {
      const { user, org } = await seedClientOrgUser(ctx);
      disablePlanMode(ctx);
      const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
      vi.useFakeTimers();
      ctx.runtime.startTurn(session.id, user.id, 'continue');
      const apex = file('A');
      ctx.repos.workspace.upsert(session.id, apex);
      ctx.repos.workspace.upsert(session.id, { ...apex, path: `${apex.path}-meta.xml`, content: '<ApexClass />' });
      ctx.runtime.noteWorkspaceChange(session.id, apex.path);
      await vi.advanceTimersByTimeAsync(599_999);
      expect(calls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(1);
      expect(ctx.repos.deploys.latest(session.id)?.scope).toBe('slice');
      vi.useRealTimers();
      release();
      await waitForIdle(ctx, session.id);
    } finally {
      vi.useRealTimers();
      release();
      ctx.db.close();
    }
  });

  it('collapses dependent compilation cascades onto a root', () => {
    const roots = rootDiagnostics([
      failure('Root'),
      ...Array.from({ length: 10 }, (_, i) => failure(`Dependent${i}`, 'Dependent class is invalid and needs recompilation: Class Root : Unexpected token')),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].components).toHaveLength(11);
    expect(rootDiagnostics([failure('Root', 'UNKNOWN_EXCEPTION: platform failure')])).toEqual([]);
  });

  it('stops after two no-progress repairs, including changed slice scope', () => {
    let state = applyCompileResult(initialCompileState(), [file('A')], [failure('A')], false, '1');
    state = applyCompileResult(state, [file('A'), file('B')], [failure('A')], false, '2');
    expect(state.noProgress).toBe(1);
    state = applyCompileResult(state, [file('A')], [failure('A')], false, '3');
    expect(state.stopped).toMatch(/two compiles/);
    expect(applyCompileResult(state, [file('B')], [], true, '4', true).stopped).toBeNull();
    expect(applyCompileResult(state, [file('B')], [], true, '4', true).roots).toEqual([]);
  });

  it('preserves failures outside a successful slice and closes staged dependencies', () => {
    const state = applyCompileResult(initialCompileState(), [file('A')], [failure('A')], false, '1');
    expect(applyCompileResult(state, [file('B')], [], true, '2').roots).toHaveLength(1);
    const files = [file('A', 'public class A { B value; }'), file('B'), file('C')];
    expect(compileSlice(files, [files[0].path]).map((f) => f.fullName)).toEqual(['A', 'B']);
    expect(missingCompanions(files)).toHaveLength(3);
    expect(compileDue({ ...initialCompileState(), dirtySince: 0 }, 600_000)).toBe(true);
    expect(compileDue({ ...initialCompileState(), dirtyPaths: Array.from({ length: 8 }, (_, i) => `${i}`) })).toBe(true);
  });

  it('persists failure gates, blocks duplicate payloads and scope growth, and supports human recovery', async () => {
    let result = outcome([failure('A')]);
    let calls = 0;
    const provider = new FakeProvider([]);
    const ctx = makeContext({
      provider,
      sf: {
        deploy: async () => {
          calls++;
          return result;
        },
      },
    });
    try {
      const { user, org } = await seedClientOrgUser(ctx);
      const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
      ctx.repos.workspace.upsert(session.id, file('A'));
      ctx.repos.workspace.upsert(session.id, file('Unrelated'));
      await ctx.runtime.validate(session.id, { agentId: 'first', testLevel: 'NoTestRun' });
      await expect(ctx.runtime.validate(session.id, { agentId: 'replacement', testLevel: 'NoTestRun' })).rejects.toThrow(/unchanged payload/);
      expect(calls).toBe(1);
      expect(createRepos(ctx.db).compileControl.get(session.id).roots).toHaveLength(1);
      expect(ctx.runtime.workspaceWriteRefusal(session.id, file('B'))).toMatch(/New components/);
      expect(ctx.runtime.workspaceWriteRefusal(session.id, file('A'))).toBeNull();
      expect(ctx.runtime.workspaceWriteRefusal(session.id, file('Unrelated'))).toMatch(/Only failing/);
      for (let i = 0; i < 2; i++) {
        ctx.repos.workspace.upsert(session.id, file('A', `broken ${i}`));
        await ctx.runtime.validate(session.id, { agentId: 'replacement', testLevel: 'NoTestRun' });
      }
      expect(ctx.repos.compileControl.get(session.id).stopped).toBeTruthy();
      await expect(ctx.runtime.validate(session.id, { agentId: 'another', testLevel: 'NoTestRun' })).rejects.toThrow(/Stopped/);
      ctx.runtime.startTurn(session.id, user.id, 'try another agent');
      await waitForIdle(ctx, session.id);
      expect(provider.requests).toHaveLength(0);
      result = outcome();
      await ctx.runtime.validate(session.id, { testLevel: 'NoTestRun' });
      expect(ctx.repos.compileControl.get(session.id).stopped).toBeNull();
      const slice = await ctx.runtime.validate(session.id, { paths: ['classes/A.cls'], testLevel: 'NoTestRun' });
      expect(slice.scope).toBe('slice');
      expect(ctx.runtime.readyToDeploy(session.id).reason).toMatch(/slice/);
    } finally {
      ctx.db.close();
    }
  });

  it('serializes org commands and freezes workspace writes while validating', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let concurrent = 0;
    let maximum = 0;
    const ctx = makeContext({
      sf: {
        deploy: async () => {
          maximum = Math.max(maximum, ++concurrent);
          entered();
          await gate;
          concurrent--;
          return outcome();
        },
      },
    });
    try {
      const { user, org } = await seedClientOrgUser(ctx);
      const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
      ctx.repos.workspace.upsert(session.id, file('A'));
      const first = ctx.runtime.validate(session.id, { testLevel: 'NoTestRun' });
      await started;
      expect(ctx.runtime.workspaceWriteRefusal(session.id, file('A'), false)).toMatch(/frozen/);
      const second = ctx.runtime.validate(session.id, { testLevel: 'NoTestRun' });
      release();
      await Promise.all([first, second]);
      expect(maximum).toBe(1);
    } finally {
      release();
      ctx.db.close();
    }
  });
});
