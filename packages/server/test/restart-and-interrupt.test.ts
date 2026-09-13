import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, waitForIdle, disablePlanMode, disableReviewerGate, nextEvent } from './helpers.js';
import { SessionRuntime } from '../src/agents/runtime.js';
import type { AppContext } from '../src/app-context.js';
import type { DeployOutcome } from '../src/salesforce/service.js';

const NS = 'http://soap.sforce.com/2006/04/metadata';
const fieldXml = (name: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="${NS}"><fullName>${name}</fullName><label>${name}</label><type>Date</type></CustomField>`;

function okDeploy(files: { path: string }[], opts: { checkOnly: boolean }): DeployOutcome {
  return {
    ok: true,
    sfDeployId: '0Af000',
    status: 'Succeeded',
    checkOnly: opts.checkOnly,
    componentsTotal: files.length,
    componentsDeployed: files.length,
    componentsFailed: 0,
    testsTotal: 0,
    testsFailed: 0,
    codeCoverage: null,
    failures: [],
    testFailures: [],
    coverageWarnings: [],
    errorMessage: null,
  };
}

/** A second runtime over the same database: what a restarted process sees. */
function restart(ctx: AppContext): AppContext {
  const runtime = new SessionRuntime(ctx);
  const ctx2 = { ...ctx, runtime } as AppContext;
  runtime.bind(ctx2);
  return ctx2;
}

describe('dirty workspace across a restart', () => {
  it('refuses to deploy a workspace that changed after its last validation, even from a fresh process', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { readComponent: async () => [], deploy: async (_o: string, f: any, o: any) => okDeploy(f, o) } as never });
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('write_workspace_file', { path: 'objects/Account/fields/A__c.field-meta.xml', content: fieldXml('A__c') }),
      () => toolCall('validate_deployment', {}),
      () => toolCall('write_workspace_file', { path: 'objects/Account/fields/B__c.field-meta.xml', content: fieldXml('B__c') }),
      () => text('staged two fields, validated one'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add fields');
    await waitForIdle(ctx, session.id);

    expect(ctx.runtime.readyToDeploy(session.id).ok).toBe(false);
    const fresh = restart(ctx);
    const ready = fresh.runtime.readyToDeploy(session.id);
    expect(ready.ok).toBe(false);
    expect(ready.reason).toContain('changed after the last validation');
    // And a workspace validated after its last change is ready from a fresh process too.
    await fresh.runtime.validate(session.id);
    expect(fresh.runtime.readyToDeploy(session.id).ok).toBe(true);
    expect(restart(ctx).runtime.readyToDeploy(session.id).ok).toBe(true);
  });
});

describe('plan approval and answers after a restart', () => {
  it('recovers a session left awaiting_plan, applies the approval, and delivers it to the model on the next turn', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('submit_plan', { summary: 'Add field A', markdown: '- Add A__c to Account', impact: 'One new Account field, visible to every sales user.' }),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add a field');
    const plan = await nextEvent(ctx, session.id, 'plan.submitted');
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('awaiting_plan');

    // The process dies here. The old runtime's turn is simply abandoned; the new one recovers.
    const fresh = restart(ctx);
    fresh.runtime.recoverOnBoot();
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('failed');
    const r = await fresh.runtime.confirm(session.id, plan.confirmationId, 'approve', user.id);
    expect(r.executed).toBe(false);
    const s = ctx.repos.sessions.byId(session.id)!;
    expect(s.planApprovedAt).toBeTruthy();
    expect(s.planMarkdown).toContain('A__c');
    expect(s.planRevision).toBe(1);

    let delivered = '';
    provider.script = [
      (req) => {
        const results = req.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as { content: string }[];
        delivered = results.map((x) => x.content).join('\n');
        return text('Building now.');
      },
    ];
    fresh.runtime.resume(session.id, user.id);
    await waitForIdle(fresh, session.id);
    expect(delivered).toContain('APPROVED the plan');
    expect(delivered).not.toContain('outcome is unknown');
  });

  it('delivers an ask_user answer recorded after a restart as the result of the question', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('ask_user', {
          question: 'Which object should carry the field?',
          options: [
            { id: 'account', label: 'Account' },
            { id: 'contact', label: 'Contact' },
          ],
        }),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add a field');
    const card = await nextEvent(ctx, session.id, 'confirmation.requested');
    expect(card.kind).toBe('question');

    const fresh = restart(ctx);
    fresh.runtime.recoverOnBoot();
    await fresh.runtime.confirm(session.id, card.confirmationId, 'contact', user.id, 'Contact, and call it Renewal Date');

    let delivered = '';
    provider.script = [
      (req) => {
        const results = req.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as { content: string }[];
        delivered = results.map((x) => x.content).join('\n');
        return text('Understood.');
      },
    ];
    fresh.runtime.startTurn(session.id, user.id, 'go on');
    await waitForIdle(fresh, session.id);
    expect(delivered).toContain('Contact, and call it Renewal Date');
    expect(delivered).toContain('after choosing "Contact"');
  });
});

describe('interrupt behaviour', () => {
  it('lets a deploy in flight finish and records its result before the session is marked cancelled', async () => {
    const provider = new FakeProvider([]);
    let realDeployStarted = false;
    const sf = {
      readComponent: async () => [],
      deploy: async (_o: string, files: any[], opts: any) => {
        if (opts.checkOnly) return okDeploy(files, opts);
        realDeployStarted = true;
        await new Promise((r) => setTimeout(r, 250));
        return okDeploy(files, opts);
      },
    };
    const ctx = makeContext({ provider, sf: sf as never });
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('write_workspace_file', { path: 'objects/Account/fields/A__c.field-meta.xml', content: fieldXml('A__c') }),
      () => toolCall('validate_deployment', {}),
      () => toolCall('request_deploy', { summary: 'Adds A', impact: 'One new Account field, visible to every sales user.' }),
      () => text('never reached: the turn was cancelled'),
    ];
    const events: any[] = [];
    ctx.runtime.bus.subscribe(session.id, (e) => events.push(e));
    ctx.runtime.startTurn(session.id, user.id, 'go');
    const conf = await nextEvent(ctx, session.id, 'confirmation.requested');
    await ctx.runtime.confirm(session.id, conf.confirmationId, 'deploy', user.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(realDeployStarted).toBe(true);
    ctx.runtime.cancel(session.id, user.id);
    // Not cancelled yet: a command that cannot be interrupted is still running.
    expect(ctx.repos.sessions.byId(session.id)!.status).not.toBe('cancelled');
    await waitForIdle(ctx, session.id);
    await new Promise((r) => setTimeout(r, 20));

    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('cancelled');
    const result = events.find((e) => e.type === 'deploy.result');
    expect(result?.ok).toBe(true);
    const cancelledAt = events.findIndex((e) => e.type === 'session.status' && e.status === 'cancelled');
    expect(events.indexOf(result)).toBeLessThan(cancelledAt);
    expect(ctx.repos.deploys.list(session.id).find((d) => !d.checkOnly)?.status).toBe('succeeded');
    // The model was not asked again after the cancel.
    expect(provider.script).toHaveLength(1);
  });
});
