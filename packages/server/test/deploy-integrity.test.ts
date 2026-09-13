import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, waitForIdle, disablePlanMode } from './helpers.js';
import type { DeployOutcome } from '../src/salesforce/service.js';
import type { AppContext } from '../src/app-context.js';

const NS = 'http://soap.sforce.com/2006/04/metadata';
const fieldXml = (label: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="${NS}"><fullName>Renewal_Date__c</fullName><label>${label}</label><type>Date</type></CustomField>`;

/** Deploys always succeed; `present` decides what a read-back of a component returns. */
function fakeSf(present: (type: string, fullName: string) => boolean, readThrows = false) {
  const deploys: any[] = [];
  return {
    deploys,
    sf: {
      readComponent: async (_orgId: string, type: string, fullName: string) => {
        if (readThrows) throw new Error('METADATA_API_UNAVAILABLE');
        return present(type, fullName) ? [{ path: `${type}/${fullName}`, content: '<xml/>' }] : [];
      },
      deploy: async (_orgId: string, files: any[], opts: any) => {
        deploys.push({ files: files.map((f) => f.path), opts });
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
        } as DeployOutcome;
      },
    },
  };
}

function stage(ctx: AppContext, sessionId: string, path: string, content: string, metadataType: string, fullName: string) {
  ctx.repos.workspace.upsert(sessionId, { path, content, original: null, metadataType, fullName, action: 'created' });
}

describe('deploy integrity', () => {
  it('refuses a deploy when the workspace changed after it was validated, naming the files', async () => {
    const { sf, deploys } = fakeSf(() => true);
    const ctx = makeContext({ provider: new FakeProvider([]), sf: sf as any });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    const path = 'objects/Account/fields/Renewal_Date__c.field-meta.xml';
    stage(ctx, session.id, path, fieldXml('Renewal Date'), 'CustomField', 'Account.Renewal_Date__c');
    await ctx.runtime.validate(session.id, {});

    // Someone edits the staged file after the clean validation, by a path that forgot to mark the
    // workspace dirty. The fingerprint is what catches it.
    stage(ctx, session.id, path, fieldXml('Renewal date'), 'CustomField', 'Account.Renewal_Date__c');

    await expect(ctx.runtime.executeDeploy(session.id, user.id, { confirmedBy: user.id })).rejects.toMatchObject({
      code: 'WORKSPACE_DRIFT',
      message: expect.stringContaining(`${path} (changed)`),
    });
    // Only the validation ran; nothing was deployed for real.
    expect(deploys.filter((d) => !d.opts.checkOnly)).toHaveLength(0);
    const errors = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'session.error') as any[];
    expect(errors.at(-1)!.message).toContain('not the ones that were validated');
    expect(errors.at(-1)!.recoverable).toBe(true);
  });

  it('names an added file in the drift refusal', async () => {
    const { sf } = fakeSf(() => true);
    const ctx = makeContext({ provider: new FakeProvider([]), sf: sf as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    stage(ctx, session.id, 'objects/Account/fields/A__c.field-meta.xml', fieldXml('A'), 'CustomField', 'Account.A__c');
    await ctx.runtime.validate(session.id, {});
    stage(ctx, session.id, 'objects/Account/fields/B__c.field-meta.xml', fieldXml('B'), 'CustomField', 'Account.B__c');
    await expect(ctx.runtime.executeDeploy(session.id, user.id, { confirmedBy: user.id })).rejects.toMatchObject({
      message: expect.stringContaining('objects/Account/fields/B__c.field-meta.xml (added)'),
    });
  });

  it('reads every deployed component back and summarises it in plain language', async () => {
    // The layout is in the org, the field is not: a deploy Salesforce accepted is not proof.
    const { sf } = fakeSf((type) => type === 'Layout');
    const ctx = makeContext({ provider: new FakeProvider([]), sf: sf as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    stage(ctx, session.id, 'objects/Contract/fields/Renewal_Date__c.field-meta.xml', fieldXml('Renewal Date'), 'CustomField', 'Contract.Renewal_Date__c');
    stage(ctx, session.id, 'layouts/Contract-Contract Layout.layout-meta.xml', '<Layout/>', 'Layout', 'Contract-Contract Layout');
    await ctx.runtime.validate(session.id, {});
    const r = await ctx.runtime.executeDeploy(session.id, user.id, { confirmedBy: user.id });

    expect(r.ok).toBe(true); // verification never turns a successful deploy into a failed one
    const verified = ctx.repos.events.listAfter(session.id).find((e) => e.type === 'deploy.verified') as any;
    expect(verified.deployId).toBe(r.deployId);
    expect(verified.ok).toBe(false);
    expect(verified.components).toEqual([
      { metadataType: 'Layout', fullName: 'Contract-Contract Layout', status: 'confirmed', note: null },
      { metadataType: 'CustomField', fullName: 'Contract.Renewal_Date__c', status: 'missing', note: null },
    ]);
    expect(verified.summary).toContain('1 of 2 changes are live in Acme UAT');
    expect(verified.summary).toContain('the Contract Contract Layout page layout');
    expect(verified.summary).toContain('Not found in the org: the Renewal_Date__c field on Contract');
    expect(r.verification).toBe(verified.summary);
  });

  it('confirms everything when the org has it, and survives a read-back failure', async () => {
    const ok = fakeSf(() => true);
    const ctx = makeContext({ provider: new FakeProvider([]), sf: ok.sf as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    stage(ctx, session.id, 'objects/Contract/fields/Renewal_Date__c.field-meta.xml', fieldXml('Renewal Date'), 'CustomField', 'Contract.Renewal_Date__c');
    await ctx.runtime.validate(session.id, {});
    const r = await ctx.runtime.executeDeploy(session.id, user.id, { confirmedBy: user.id });
    const verified = ctx.repos.events.listAfter(session.id).find((e) => e.type === 'deploy.verified') as any;
    expect(verified.ok).toBe(true);
    expect(verified.summary).toBe('Now live in Acme UAT: the Renewal_Date__c field on Contract.');
    expect(r.ok).toBe(true);

    // Same again with a metadata API that will not answer: reported, never fatal.
    const broken = fakeSf(() => true, true);
    const ctx2 = makeContext({ provider: new FakeProvider([]), sf: broken.sf as any });
    const seeded = await seedClientOrgUser(ctx2);
    const s2 = ctx2.runtime.createSession({ userId: seeded.user.id, orgId: seeded.org.id, uiMode: 'pro' });
    stage(ctx2, s2.id, 'objects/Contract/fields/Renewal_Date__c.field-meta.xml', fieldXml('Renewal Date'), 'CustomField', 'Contract.Renewal_Date__c');
    await ctx2.runtime.validate(s2.id, {});
    const r2 = await ctx2.runtime.executeDeploy(s2.id, seeded.user.id, { confirmedBy: seeded.user.id });
    expect(r2.ok).toBe(true);
    const v2 = ctx2.repos.events.listAfter(s2.id).find((e) => e.type === 'deploy.verified') as any;
    expect(v2.components[0].status).toBe('unreadable');
    expect(v2.components[0].note).toContain('METADATA_API_UNAVAILABLE');
    expect(v2.summary).toContain('Could not be checked');
  });

  it('applies the permission rules to the manual deploy and commit paths too', async () => {
    const { sf, deploys } = fakeSf(() => true);
    const ctx = makeContext({ provider: new FakeProvider([]), sf: sf as any });
    const { user, org } = await seedClientOrgUser(ctx);
    ctx.repos.policies.set('global', { impactDenyList: ['deploy(CustomField:*)'], requirePlanApproval: 'never' }, 'u');
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    stage(ctx, session.id, 'objects/Account/fields/A__c.field-meta.xml', fieldXml('A'), 'CustomField', 'Account.A__c');
    await ctx.runtime.validate(session.id, {});
    await expect(ctx.runtime.executeDeploy(session.id, user.id, { confirmedBy: user.id })).rejects.toMatchObject({ code: 'POLICY', status: 403 });
    expect(deploys.filter((d) => !d.opts.checkOnly)).toHaveLength(0);
    const blocked = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'policy.blocked') as any[];
    expect(blocked.at(-1)!.tool).toBe('deploy');
  });
});

describe('blast radius (impact)', () => {
  it('refuses a gated command, a plan and a deploy request without a usable impact', async () => {
    const { sf } = fakeSf(() => true);
    const ctx = makeContext({ provider: new FakeProvider([]), sf: sf as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });

    const gated = await ctx.runtime.gate({
      sessionId: session.id,
      agentId: 'orchestrator',
      command: 'execute_anonymous_apex',
      reason: 'Check the debug output of the renewal job.',
      impact: 'n/a',
      input: { apex: 'System.debug(1);' },
      title: 'Run anonymous Apex?',
      subjects: ['read-only'],
    });
    expect(gated).toContain('provide an "impact"');
    expect(gated).toContain('users, profiles, automations, record counts');
    // No confirmation card was opened: the refusal happens before the user is bothered.
    expect(ctx.repos.confirmations.pending(session.id)).toHaveLength(0);

    const plan = await ctx.runtime.submitPlan(session.id, 'Add a field', '## Plan', '');
    expect(plan.ok).toBe(false);
    expect(plan.text).toContain('provide an "impact"');

    const deploy = await ctx.runtime.requestDeploy(session.id, 'Ship the field', 'short');
    expect(deploy.ok).toBe(false);
    expect(deploy.text).toContain('provide an "impact"');
    expect(ctx.repos.deploys.list(session.id)).toHaveLength(0);
  });

  it('carries the impact through the gate into the confirmation event', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { executeAnonymous: async () => ({ success: true, logs: '' }) } as any });
    disablePlanMode(ctx);
    ctx.repos.policies.set('global', { impactAllowList: ['execute_anonymous_apex'], requirePlanApproval: 'never' }, 'u');
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    const impact = 'Reads the renewal job schedule only. No users, automations or records are affected.';
    provider.script = [
      () => ({
        content: [
          {
            type: 'tool_use' as const,
            id: 'tu_1',
            name: 'execute_anonymous_apex',
            input: { apex: 'System.debug(1);', reason: 'Check the renewal job schedule for the user.', impact },
          },
        ],
        stopReason: 'tool_use' as const,
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      }),
    ];
    const requested = new Promise<any>((resolve) => {
      const unsub = ctx.runtime.bus.subscribe(session.id, (e) => {
        if (e.type === 'confirmation.requested') {
          unsub();
          resolve(e);
        }
      });
    });
    ctx.runtime.startTurn(session.id, user.id, 'check the renewal job');
    const conf = await requested;
    expect(conf.impact).toBe(impact);
    expect(ctx.repos.confirmations.byId(conf.confirmationId)!.payload.impact).toBe(impact);
    await ctx.runtime.confirm(session.id, conf.confirmationId, 'approve', user.id);
    await waitForIdle(ctx, session.id);
  });
});
