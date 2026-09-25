import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, waitForIdle, disablePlanMode, nextEvent } from './helpers.js';
import { classifyAnonymousApex } from '../src/agents/apex-classify.js';
import { REVIEW_VERDICT_NOTE } from '../src/agents/runtime.js';
import type { DeployOutcome } from '../src/salesforce/service.js';

const NS = 'http://soap.sforce.com/2006/04/metadata';
const fieldXml = (name: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="${NS}"><fullName>${name}</fullName><label>${name}</label><type>Date</type></CustomField>`;

const okDeploy = (files: { path: string }[], opts: { checkOnly: boolean }): DeployOutcome => ({
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
});

describe('anonymous Apex classification', () => {
  const mutating = [
    "insert new Account(Name = 'x');",
    'Database.executeBatch(new MyBatch(), 200);',
    "System.schedule('job', '0 0 * * * ?', new MySchedulable());",
    'System.enqueueJob(new MyQueueable());',
    'Messaging.sendEmail(new List<Messaging.SingleEmailMessage>());',
    'EventBus.publish(new My_Event__e());',
    'Approval.process(new Approval.ProcessSubmitRequest());',
    'HttpResponse r = new Http().send(new HttpRequest());',
    'MyService.run();',
    'delete [SELECT Id FROM Account LIMIT 1];',
    'Database.update(accs, false);',
    'Test.startTest();',
  ];
  const readOnly = [
    'System.debug(1);',
    'System.debug([SELECT Id, Name FROM Account LIMIT 5]);',
    'List<Account> accs = [SELECT Id FROM Account LIMIT 10]; System.debug(accs.size());',
    "for (Account a : [SELECT Id, Name FROM Account WHERE Name LIKE 'insert%']) { System.debug(a.Name); }",
    'Map<Id, Contact> byId = new Map<Id, Contact>([SELECT Id FROM Contact]); System.debug(byId.keySet().size()); // update later',
    "String s = 'delete everything'; System.debug(s.toUpperCase());",
    "System.debug(Schema.getGlobalDescribe().get('Account').getDescribe().getLabel());",
    "System.debug(JSON.serializePretty(Database.query('SELECT Id FROM User LIMIT 1')));",
  ];
  it('treats anything that can change the org as mutating, including calls into unknown classes', () => {
    for (const apex of mutating) expect({ apex, effect: classifyAnonymousApex(apex).effect }).toEqual({ apex, effect: 'mutating' });
  });
  it('recognises query-and-debug scripts as read-only, and is not fooled by strings or comments', () => {
    for (const apex of readOnly) expect({ apex, effect: classifyAnonymousApex(apex).effect }).toEqual({ apex, effect: 'read-only' });
  });
  it('says what tipped the decision', () => {
    expect(classifyAnonymousApex('MyService.run();').reason).toContain('MyService.run');
  });
});

describe('session grants are per subject', () => {
  it('does not let "allow for this session" on one test class cover another, and wants a reason even when granted', async () => {
    const provider = new FakeProvider([]);
    const ran: string[][] = [];
    const ctx = makeContext({
      provider,
      sf: {
        runTests: async (_o: string, classes: string[]) => {
          ran.push(classes);
          return [];
        },
        limits: async () => ({ orgId: 'o', fetchedAt: new Date().toISOString(), limits: [], warnings: [] }),
      } as never,
    });
    disablePlanMode(ctx);
    ctx.repos.policies.set('global', { impactAllowList: ['run_apex_tests'], sessionAllowable: ['run_apex_tests'], requirePlanApproval: 'never' }, 'u');
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    let shortReasonResult = '';
    provider.script = [
      () =>
        toolCall('run_apex_tests', {
          classNames: ['FooTest'],
          reason: 'Verify the current behaviour of the renewal job.',
          impact: 'Sandbox only; no users or records are affected.',
        }),
      () =>
        toolCall('run_apex_tests', {
          classNames: ['FooTest', 'BarTest'],
          reason: 'Now the second class as well, same purpose.',
          impact: 'Sandbox only; no users or records are affected.',
        }),
      () => toolCall('run_apex_tests', { classNames: ['FooTest'], reason: 'x', impact: 'Sandbox only; no users or records are affected.' }),
      (req) => {
        shortReasonResult = (req.messages.at(-1)!.content[0] as { content: string }).content;
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'test things');
    const c1 = await nextEvent(ctx, session.id, 'confirmation.requested');
    await ctx.runtime.confirm(session.id, c1.confirmationId, 'approve_session', user.id);
    expect(ctx.repos.permissions.list(session.id).map((p) => p.command)).toEqual(['run_apex_tests(FooTest)']);
    // BarTest is not covered by the grant: a second card.
    const c2 = await nextEvent(ctx, session.id, 'confirmation.requested');
    expect(c2.command.input.classNames).toEqual(['FooTest', 'BarTest']);
    await ctx.runtime.confirm(session.id, c2.confirmationId, 'approve', user.id);
    await waitForIdle(ctx, session.id);
    expect(ran).toEqual([['FooTest'], ['FooTest', 'BarTest']]);
    // Granted, but the reason check comes first.
    expect(shortReasonResult).toContain('reason');
    expect(ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'confirmation.requested')).toHaveLength(2);
  });
});

describe('executeDeploy and executeCommit honour the rules and the confirmation', () => {
  it('refuses a denied deploy and an unconfirmed one, then deploys with proof of confirmation', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { readComponent: async () => [], deploy: async (_o: string, f: any, o: any) => okDeploy(f, o) } as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('write_workspace_file', { path: 'objects/Account/fields/A__c.field-meta.xml', content: fieldXml('A__c') }),
      () => toolCall('validate_deployment', {}),
      () => text('validated'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'stage');
    await waitForIdle(ctx, session.id);
    expect(ctx.runtime.readyToDeploy(session.id).ok).toBe(true);

    ctx.repos.policies.set('global', { impactDenyList: ['deploy(CustomField:*)'], requirePlanApproval: 'never' }, 'u');
    await expect(ctx.runtime.executeDeploy(session.id, user.id, { confirmedBy: user.id })).rejects.toThrow(/denied/);
    expect(ctx.repos.events.listAfter(session.id).some((e) => e.type === 'policy.blocked')).toBe(true);

    ctx.repos.policies.set('global', { requirePlanApproval: 'never' }, 'u');
    await expect(ctx.runtime.executeDeploy(session.id, user.id)).rejects.toThrow(/confirmation/i);
    const r = await ctx.runtime.executeDeploy(session.id, user.id, { confirmedBy: user.id });
    expect(r.ok).toBe(true);
    // Commits: the same two checks, plus nothing to commit here without a repository.
    await expect(ctx.runtime.executeCommit(session.id, user.id, 'msg', false)).rejects.toThrow();
  });
});

describe('reviewer verdict gate', () => {
  it('refuses request_deploy on FAIL, and lets a PASS on the same workspace through', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { readComponent: async () => [], deploy: async (_o: string, f: any, o: any) => okDeploy(f, o) } as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const refusals: string[] = [];
    provider.script = [
      () => toolCall('write_workspace_file', { path: 'objects/Account/fields/A__c.field-meta.xml', content: fieldXml('A__c') }),
      () => toolCall('write_workspace_file', { path: 'objects/Account/fields/B__c.field-meta.xml', content: fieldXml('B__c') }),
      () => toolCall('validate_deployment', {}),
      () => toolCall('request_deploy', { summary: 'two fields, no review yet', impact: 'Two new Account fields visible to every sales user.' }),
      (req) => {
        refusals.push((req.messages.at(-1)!.content[0] as { content: string }).content);
        return toolCall('run_subagent', { role: 'general', objective: 'review the two fields' });
      },
      () => text('BLOCKERS: B__c has no description.\nVERDICT: FAIL'),
      () => toolCall('request_deploy', { summary: 'two fields, failed review', impact: 'Two new Account fields visible to every sales user.' }),
      (req) => {
        refusals.push((req.messages.at(-1)!.content[0] as { content: string }).content);
        return toolCall('run_subagent', { role: 'general', objective: 'review again' });
      },
      () => text('No blockers.\nVERDICT: PASS'),
      () => toolCall('request_deploy', { summary: 'two fields, reviewed', impact: 'Two new Account fields visible to every sales user.' }),
      () => text('deployed'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add two fields');
    const conf = await nextEvent(ctx, session.id, 'confirmation.requested');
    expect(conf.kind).toBe('deploy');
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toContain('no reviewer verdict');
    expect(refusals[1]).toContain('VERDICT: FAIL');
    await ctx.runtime.confirm(session.id, conf.confirmationId, 'deploy', user.id);
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.notes.byTitle(session.id, REVIEW_VERDICT_NOTE)?.content).toContain('verdict: PASS');
    expect(ctx.repos.deploys.list(session.id).filter((d) => !d.checkOnly)).toHaveLength(1);
  });
});

describe('plan gate and read-only delegation', () => {
  it('allows an analyst while unplanned even in "always" mode, and still refuses a builder', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    ctx.repos.policies.set('global', { requirePlanApproval: 'always' }, 'u');
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    let builderResult = '';
    provider.script = [
      () => toolCall('run_subagent', { role: 'explore', objective: 'look' }),
      () => text('FINDINGS: nothing'),
      () => toolCall('run_subagent', { role: 'general', objective: 'build' }),
      (req) => {
        builderResult = (req.messages.at(-1)!.content[0] as { content: string }).content;
        return text('need a plan first');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    const spawned = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'agent.spawned') as { role: string }[];
    expect(spawned.map((e) => e.role)).toEqual(['explore']);
    expect(builderResult).toContain('no approved plan');
  });
});
