import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkspaceFile, DeployFailure } from '@sf-claws/shared';
import { makeContext, seedClientOrgUser, FakeProvider, waitForIdle } from './helpers.js';
import { normalizeDeployResult } from '../src/salesforce/service.js';
import { SessionRuntime } from '../src/agents/runtime.js';
import { createRepos } from '../src/db/repos/index.js';
import { classifyFailure } from '../src/agents/validation-recovery.js';

const field = (name: string, content = '<CustomField/>'): WorkspaceFile => ({
  path: `objects/Account/fields/${name}.field-meta.xml`,
  content,
  original: null,
  action: 'created',
  metadataType: 'CustomField',
  fullName: `Account.${name}`,
});
const problem = (name: string): DeployFailure => ({
  componentType: 'CustomField',
  fullName: `Account.${name}`,
  fileName: null,
  problem: 'Invalid field',
  problemType: 'Error',
  lineNumber: 1,
  columnNumber: 1,
});
const result = (failures: DeployFailure[] = []) =>
  normalizeDeployResult({
    id: '0Af000000000001',
    status: failures.length ? 'Failed' : 'Succeeded',
    success: !failures.length,
    checkOnly: true,
    details: { componentFailures: failures },
    numberComponentsTotal: 2,
    numberComponentErrors: failures.length,
  });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('durable validation recovery', () => {
  it.each(['UNKNOWN_EXCEPTION', 'UNABLE_TO_LOCK_ROW', 'ENTITY_IS_LOCKED'])('bounds %s retries and does not increment compiler repair counts', async (code) => {
    const deploy = vi.fn(async () => result([{ ...problem('A__c'), problem: code }]));
    const ctx = makeContext({ sf: { deploy } });
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.workspace.upsert(session.id, field('A__c'));
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const pending = ctx.runtime.validate(session.id);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await pending).status).toBe('failed');
    expect(deploy).toHaveBeenCalledTimes(3);
    expect(ctx.repos.compileControl.get(session.id).roots).toEqual([]);
    expect(ctx.repos.compileControl.get(session.id).stopped).toBeTruthy();
    expect(ctx.repos.harness.active(org.id)).toBeUndefined();
    ctx.db.close();
  });

  it('does not retry a definitive auth rejection and releases the org lease', async () => {
    const deploy = vi.fn(async () => {
      throw new Error('INVALID_SESSION_ID');
    });
    const ctx = makeContext({ sf: { deploy } });
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.workspace.upsert(session.id, field('A__c'));
    expect((await ctx.runtime.validate(session.id)).status).toBe('failed');
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(ctx.repos.harness.active(org.id)).toBeUndefined();
    ctx.db.close();
  });

  it('retries platform failures twice with identical archived bytes and no repair iterations', async () => {
    const platform = result([{ ...problem('A__c'), componentType: null, fullName: null, problem: 'UNKNOWN_EXCEPTION: ErrorId 123' }]);
    const deploy = vi.fn().mockResolvedValueOnce(platform).mockResolvedValueOnce(platform).mockResolvedValueOnce(result());
    const ctx = makeContext({ sf: { deploy, prepareDeploy: async () => Buffer.from('exact zip bytes').toString('base64') } });
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.workspace.upsert(session.id, field('A__c'));
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const pending = ctx.runtime.validate(session.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(deploy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(deploy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deploy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await pending).status).toBe('succeeded');
    expect(deploy).toHaveBeenCalledTimes(3);
    for (const call of deploy.mock.calls) expect(call[2].preparedZip.toString()).toBe('exact zip bytes');
    const checkpoint = ctx.repos.harness.list(session.id)[0];
    expect(ctx.repos.harness.attempts(session.id, checkpoint.id)).toHaveLength(3);
    expect(ctx.repos.compileControl.get(session.id).checks).toBe(1);
    expect(ctx.repos.compileControl.get(session.id).noProgress).toBe(0);
    expect(createRepos(ctx.db).harness.get(session.id, checkpoint.id)?.payload.zipBase64).toBe(Buffer.from('exact zip bytes').toString('base64'));
    ctx.db.close();
  });

  it('quarantines a regressing candidate and atomically restores the prior staged tree', async () => {
    const deploy = vi
      .fn()
      .mockResolvedValueOnce(result([problem('A__c')]))
      .mockResolvedValueOnce(result([problem('A__c'), problem('B__c')]));
    const ctx = makeContext({ sf: { deploy } });
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.workspace.upsert(session.id, field('A__c', 'earlier A'));
    ctx.repos.workspace.upsert(session.id, field('B__c', 'earlier B'));
    await ctx.runtime.validate(session.id);
    ctx.repos.workspace.upsert(session.id, field('A__c', 'regressing A'));
    await ctx.runtime.validate(session.id);
    expect(ctx.repos.workspace.get(session.id, field('A__c').path)?.content).toBe('earlier A');
    const [failed, prior] = ctx.repos.harness.list(session.id);
    expect(failed.status).toBe('quarantined');
    expect(failed.restoredFrom).toBe(prior.id);
    expect(failed.workspace.find((f) => f.fullName === 'Account.A__c')?.content).toBe('regressing A');
    expect(ctx.runtime.readyToDeploy(session.id).ok).toBe(false);
    expect(ctx.repos.compileControl.get(session.id).stopped).toContain('regressed');
    ctx.db.close();
  });

  it('reconciles an acknowledged job after runtime replacement without resubmitting', async () => {
    const deploy = vi.fn(async (_org, _files, opts) => {
      opts.onSubmitted?.('0Af000000000001');
      throw new Error('socket lost');
    });
    const resumeValidation = vi.fn(async () => result());
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { deploy, resumeValidation } });
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.workspace.upsert(session.id, field('A__c'));
    await expect(ctx.runtime.validate(session.id)).rejects.toThrow(/uncertain/);
    const checkpoint = ctx.repos.harness.list(session.id)[0];
    ctx.runtime = new SessionRuntime(ctx);
    ctx.runtime.bind(ctx);
    ctx.runtime.startTurn(session.id, user.id, 'continue');
    await waitForIdle(ctx, session.id);
    expect(provider.requests).toHaveLength(0);
    await ctx.runtime.reconcileCheckpoint(session.id, checkpoint.id);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(resumeValidation).toHaveBeenCalledTimes(1);
    expect(ctx.repos.harness.active(org.id)).toBeUndefined();
    expect(ctx.runtime.readyToDeploy(session.id).ok).toBe(false);
    ctx.db.close();
  });

  it('never resubmits a lost acknowledgement with no job ID', async () => {
    const deploy = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const ctx = makeContext({ sf: { deploy } });
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.workspace.upsert(session.id, field('A__c'));
    await expect(ctx.runtime.validate(session.id)).rejects.toThrow(/uncertain/);
    const checkpoint = ctx.repos.harness.list(session.id)[0];
    await expect(ctx.runtime.reconcileCheckpoint(session.id, checkpoint.id)).rejects.toThrow(/No acknowledged job ID/);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(ctx.repos.harness.active(org.id)?.id).toBe(checkpoint.id);
    ctx.db.close();
  });

  it('refuses a model resume while manual validation is required', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { deploy: async () => result() } });
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.workspace.upsert(session.id, field('A__c'));
    const state = ctx.repos.compileControl.get(session.id);
    state.stopped = 'Salesforce returned a platform failure without component diagnostics.';
    ctx.repos.compileControl.set(session.id, state);

    expect(() => ctx.runtime.resume(session.id, user.id)).toThrow(/Open Changes.*full validation/i);
    expect(provider.requests).toHaveLength(0);

    expect((await ctx.runtime.validate(session.id)).status).toBe('succeeded');
    expect(ctx.repos.compileControl.get(session.id).stopped).toBeNull();
    ctx.db.close();
  });

  it('classifies compiler, test, coverage, auth and platform errors independently', () => {
    expect(classifyFailure(result([problem('A__c')]))).toBe('component');
    expect(classifyFailure(new Error('INVALID_SESSION_ID'))).toBe('auth');
    expect(classifyFailure(new Error('REQUEST_LIMIT_EXCEEDED'))).toBe('quota');
    expect(classifyFailure(new Error('UNKNOWN_EXCEPTION'))).toBe('platform');
    expect(classifyFailure(result([{ ...problem('A__c'), problemType: 'TestFailure' }]))).toBe('test');
    expect(classifyFailure(result([{ ...problem('A__c'), componentType: 'CodeCoverage' }]))).toBe('coverage');
  });
});
