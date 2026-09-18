import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, waitForIdle, disablePlanMode, disableReviewerGate, nextEvent } from './helpers.js';
import type { DeployOutcome } from '../src/salesforce/service.js';

const NS = 'http://soap.sforce.com/2006/04/metadata';
const fieldXml = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="${NS}"><fullName>Renewal_Date__c</fullName><label>Renewal Date</label><type>Date</type></CustomField>`;

function fakeSf(deployResults: Partial<DeployOutcome>[]) {
  const calls: any[] = [];
  return {
    calls,
    sf: {
      query: async () => ({ totalSize: 1, done: true, records: [{ Id: '001x', Name: 'Acme' }], columns: ['Id', 'Name'] }),
      readComponent: async () => [],
      describe: async () => ({ name: 'Account', fields: [] }),
      deploy: async (_orgId: string, files: any[], opts: any) => {
        calls.push({ files: files.map((f) => f.path), opts });
        const r = deployResults.shift() ?? {};
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
          ...r,
        } as DeployOutcome;
      },
    },
  };
}

describe('session runtime', () => {
  it('runs an orchestrator turn with a sub-agent, validates until clean, gates deploy on confirmation and documents', async () => {
    const provider = new FakeProvider([]);
    const { sf, calls } = fakeSf([
      {
        ok: false,
        componentsFailed: 1,
        failures: [
          {
            componentType: 'CustomField',
            fullName: 'Account.Renewal_Date__c',
            fileName: 'objects/Account.object',
            problem: 'Bad label',
            problemType: 'Error',
            lineNumber: 3,
            columnNumber: 1,
          },
        ],
      },
      {}, // second validation clean
      {}, // real deploy
    ]);
    const ctx = makeContext({ provider, sf: sf as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });

    // Script: orchestrator -> soql -> delegate to metadata_builder; builder -> write -> validate(fail) -> write -> validate(ok) -> report;
    // orchestrator -> request_deploy -> (confirmed) -> write_documentation -> final text
    provider.script = [
      () => toolCall('soql_query', { soql: 'SELECT Id, Name FROM Account LIMIT 1' }),
      () =>
        toolCall('submit_plan', {
          summary: 'Add a Renewal Date field to Account',
          markdown: '## Plan\n- Add Renewal_Date__c (Date) to Account\n- Validate against the org\n- Add it to the Sales permission set',
          impact: 'Every sales user sees one new date field on Account; no existing records or automations change.',
        }),
      () => toolCall('run_subagent', { role: 'metadata_builder', objective: 'Add Renewal_Date__c to Account' }),
      // sub-agent (fresh conversation)
      () => toolCall('write_workspace_file', { path: 'objects/Account/fields/Renewal_Date__c.field-meta.xml', content: fieldXml }),
      () => toolCall('validate_deployment', {}),
      (req) => {
        const result = req.messages
          .flatMap((m) => m.content)
          .filter((b) => b.type === 'tool_result')
          .at(-1);
        expect(result).toMatchObject({ type: 'tool_result', isError: true });
        return toolCall('write_workspace_file', {
          path: 'objects/Account/fields/Renewal_Date__c.field-meta.xml',
          content: fieldXml.replace('Renewal Date', 'Renewal date'),
        });
      },
      () => toolCall('validate_deployment', {}),
      () => text('Staged and validated Renewal_Date__c.'),
      // back in orchestrator
      () => toolCall('request_deploy', { summary: 'Adds Renewal Date to Account', impact: 'Sales users get one new field on Account; no records change.' }),
      () =>
        toolCall('write_documentation', {
          title: 'Add Renewal Date to Account',
          summary: 'Added a date field.',
          technical: 'Field added.',
          endUser: 'You will see Renewal Date.',
          tags: ['Account', 'field'],
        }),
      () => text('Deployed the new field. Assign the permission set to make it visible.'),
    ];

    const events: any[] = [];
    ctx.runtime.bus.subscribe(session.id, (e) => events.push(e));
    ctx.runtime.startTurn(session.id, user.id, 'Add a Renewal Date field on Account');

    // Plan mode: the lead agent must get sign-off before any builder stages metadata.
    const plan = await nextEvent(ctx, session.id, 'plan.submitted');
    expect(plan.markdown).toContain('Renewal_Date__c');
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('awaiting_plan');
    await ctx.runtime.confirm(session.id, plan.confirmationId, 'approve', user.id);
    expect(ctx.repos.sessions.byId(session.id)!.planApprovedAt).toBeTruthy();

    // then the deploy confirmation
    const conf = await nextEvent(ctx, session.id, 'confirmation.requested');
    expect(conf.kind).toBe('deploy');
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('awaiting_confirmation');
    expect(conf.details.files).toHaveLength(1);
    await ctx.runtime.confirm(session.id, conf.confirmationId, 'deploy', user.id);
    await waitForIdle(ctx, session.id);

    const s = ctx.repos.sessions.byId(session.id)!;
    expect(s.status).toBe('idle');
    const types = events.map((e) => e.type);
    expect(types).toContain('agent.spawned');
    expect(types).toContain('agent.finished');
    expect(types.filter((t) => t === 'deploy.validation')).toHaveLength(2);
    expect(events.find((e) => e.type === 'deploy.validation' && e.attempt === 1).ok).toBe(false);
    expect(events.find((e) => e.type === 'deploy.validation' && e.attempt === 2).ok).toBe(true);
    expect(events.find((e) => e.type === 'deploy.result').ok).toBe(true);
    expect(types).toContain('doc.written');
    expect(calls).toHaveLength(3);
    expect(calls[0].opts.checkOnly).toBe(true);
    expect(calls[2].opts.checkOnly).toBe(false);
    // usage + cost tracked
    expect(s.inputTokens).toBeGreaterThan(0);
    expect(s.costUsd).toBeGreaterThan(0);
    expect(ctx.repos.usage.bySession(session.id).length).toBe(11);
    expect(ctx.repos.usage.bySession(session.id).some((u) => u.role === 'metadata_builder')).toBe(true);
    // doc persisted & searchable
    const docs = ctx.repos.docs.bySession(session.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].markdown).toContain('## End-user documentation');
    expect(ctx.repos.docs.search(org.id, 'renewal date field')[0]?.id).toBe(docs[0].id);
    // orchestrator history persisted for the next turn
    expect(ctx.repos.messages.list(session.id, 'orchestrator').length).toBeGreaterThan(4);
    // sub-agent got its objective in the first user message, not in the (cached) system prompt
    const subReq = provider.requests.find((r) => (r.messages[0].content[0] as { text?: string }).text?.includes('Your objective for this run'));
    expect(subReq).toBeTruthy();
    expect((subReq!.messages[0].content[0] as { text: string }).text).toContain('Add Renewal_Date__c to Account');
    expect(subReq!.system).not.toContain('Add Renewal_Date__c to Account');
  });

  it('refuses request_deploy without a clean validation and auto-documents meaningful turns', async () => {
    const provider = new FakeProvider([]);
    const { sf } = fakeSf([]);
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro', title: 'Deploy gate' });
    provider.script = [
      () => toolCall('write_workspace_file', { path: 'flows/X.flow-meta.xml', content: `<?xml version="1.0"?><Flow xmlns="${NS}"><label>X</label></Flow>` }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.isError).toBe(false);
        return toolCall('request_deploy', { summary: 'ship it', impact: 'Adds one flow that runs for every new Account.' });
      },
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('Cannot request deploy');
        return text('I need to validate first.');
      },
      // auto doc writer sub-agent
      () => toolCall('write_documentation', { title: 'Auto doc', summary: 'sum', technical: 't', endUser: 'e' }),
      () => text('done'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'deploy flow X');
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.deploys.list(session.id)).toHaveLength(0);
    expect(ctx.repos.docs.bySession(session.id)).toHaveLength(1);
    expect(ctx.repos.docs.bySession(session.id)[0].title).toBe('Auto doc');
    const spawned = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'agent.spawned') as any[];
    expect(spawned[0].role).toBe('doc_writer');
  });

  it('enforces policy in write_workspace_file and rejects concurrent turns', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as any });
    ctx.repos.policies.set(
      'global',
      { protectedComponents: ['yourns__*', '*.yourns__*'], forbiddenMetadataTypes: ['Profile'], requirePlanApproval: 'never' },
      'u',
    );
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('write_workspace_file', { path: 'objects/yourns__Contract__c/fields/Foo__c.field-meta.xml', content: fieldXml }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.isError).toBe(true);
        expect(last.content).toContain('POLICY VIOLATION');
        return toolCall('write_workspace_file', { path: 'profiles/Admin.profile-meta.xml', content: `<?xml version="1.0"?><Profile xmlns="${NS}"/>` });
      },
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('forbiddenMetadataTypes');
        return text('Cannot do that.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'edit package field');
    expect(() => ctx.runtime.startTurn(session.id, user.id, 'again')).toThrow(/already running/);
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.workspace.list(session.id)).toHaveLength(0);
  });

  it('cancel aborts a pending confirmation and marks the session cancelled', async () => {
    const provider = new FakeProvider([]);
    const { sf } = fakeSf([{}]);
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('write_workspace_file', { path: 'flows/X.flow-meta.xml', content: `<?xml version="1.0"?><Flow xmlns="${NS}"><label>X</label></Flow>` }),
      () => toolCall('validate_deployment', {}),
      () => toolCall('request_deploy', { summary: 's', impact: 'Adds one flow that runs for every new Account.' }),
      () => text('never reached'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await new Promise<void>((resolve) => {
      const unsub = ctx.runtime.bus.subscribe(session.id, (e) => {
        if (e.type === 'confirmation.requested') {
          unsub();
          resolve();
        }
      });
    });
    ctx.runtime.cancel(session.id, user.id);
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('cancelled');
    expect(ctx.repos.confirmations.pending(session.id)).toHaveLength(0);
    expect(ctx.repos.deploys.list(session.id).filter((d) => !d.checkOnly)).toHaveLength(0);
  });

  it('reuses an untouched session on New session, and stops once it has a message or is completed', async () => {
    const provider = new FakeProvider([() => text('Hello.')]);
    const ctx = makeContext({ provider });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const a = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    expect(ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' }).id).toBe(a.id);

    ctx.runtime.startTurn(a.id, user.id, 'hi');
    await waitForIdle(ctx, a.id);
    const b = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    expect(b.id).not.toBe(a.id);

    expect(ctx.runtime.completeSession(b.id).status).toBe('completed');
    expect(ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' }).id).not.toBe(b.id);
  });
});
