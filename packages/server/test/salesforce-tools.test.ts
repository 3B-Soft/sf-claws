import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, waitForIdle, disablePlanMode, disableReviewerGate } from './helpers.js';

// `gate()` emits `confirmation.requested` and only registers the waiter afterwards (still
// synchronously, but after the emit returns), so a subscriber must not call `confirm()` from
// inside its own callback — that races the registration. Resolve with the event and confirm
// after the `await` returns, the way test/gate.test.ts does.
const waitConfirmation = (ctx: any, sessionId: string) =>
  new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no confirmation')), 8000);
    const unsub = ctx.runtime.bus.subscribe(sessionId, (e: any) => {
      if (e.type === 'confirmation.requested') {
        clearTimeout(t);
        unsub();
        resolve(e);
      }
    });
  });

/**
 * Review Tier 1 #4 and Tier 3: the harness gained service-layer support for reading a user's
 * installed packages, folders and component dependencies, and for turning on Apex debug logging
 * and activating/deactivating a Flow version — but nothing exposed them as agent tools. These
 * tests exercise each one through the real agent loop and gate.
 */
describe('new Salesforce tools', () => {
  it('list_installed_packages, list_folders and component_dependencies answer without a gate', async () => {
    const provider = new FakeProvider([]);
    const sf = {
      listInstalledPackages: async () => [
        { id: '0A3x', name: 'NW WFM', namespace: 'nwwfm', version: '4.2.0.1', versionName: '4.2', versionId: '04t', description: null },
      ],
      listFolders: async () => [{ fullName: 'Client Reports', id: '00lx', lastModifiedDate: '2026-01-01T00:00:00Z' }],
      componentDependencies: async () => ({
        available: true,
        note: null,
        dependents: [{ type: 'ApexClass', name: 'ContractRenewalService', id: '01px' }],
      }),
    };
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('list_installed_packages', {}),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.isError).toBe(false);
        expect(last.content).toContain('NW WFM');
        expect(last.content).toContain('nwwfm');
        return toolCall('list_folders', { type: 'Report' });
      },
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('Client Reports');
        return toolCall('component_dependencies', { type: 'CustomField', fullName: 'Account.Old__c' });
      },
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('ContractRenewalService');
        return text('Done.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'what is installed, and what depends on this field?');
    await waitForIdle(ctx, session.id);
  });

  it('component_dependencies degrades to a note, not a false "nothing depends on it", when the org lacks the API', async () => {
    const provider = new FakeProvider([]);
    const sf = {
      componentDependencies: async () => ({
        available: false,
        note: 'Dependency lookup is not available in this org (INVALID_TYPE). Check references manually before deleting.',
        dependents: [],
      }),
    };
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('component_dependencies', { type: 'CustomField', fullName: 'Account.Old__c' }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('not available in this org');
        expect(last.content).not.toContain('No dependents found');
        return text('Done.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'what depends on this field?');
    await waitForIdle(ctx, session.id);
  });

  it('set_trace_flag shows the reason on a confirmation card, and executes only once approved', async () => {
    const provider = new FakeProvider([]);
    const calls: unknown[] = [];
    const sf = {
      ensureTraceFlag: async (_orgId: string, opts: any) => {
        calls.push(opts);
        return { traceFlagId: '7tf', debugLevelId: '01i', userId: opts.userId ?? '005self', expirationDate: '2026-01-01T01:00:00Z', created: true };
      },
    };
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('set_trace_flag', {
          minutes: 30,
          reason: 'Capture logs to debug the failing renewal batch.',
          impact: 'Debug logs for one user for 30 minutes; nothing else changes.',
        }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.isError).toBe(false);
        expect(last.content).toContain('enabled');
        expect(calls.length).toBe(1);
        return text('Debug logging is on for 30 minutes.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'turn on debug logs for me');
    const c = await waitConfirmation(ctx, session.id);
    expect(c.command.name).toBe('set_trace_flag');
    expect(c.description).toContain('Capture logs');
    await ctx.runtime.confirm(session.id, c.confirmationId, 'approve', user.id);
    await waitForIdle(ctx, session.id);
  });

  it('set_trace_flag never runs when the user denies the card', async () => {
    const provider = new FakeProvider([]);
    const calls: unknown[] = [];
    const sf = {
      ensureTraceFlag: async (_orgId: string, opts: any) => {
        calls.push(opts);
        return {} as any;
      },
    };
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('set_trace_flag', {
          minutes: 30,
          reason: 'Capture logs to debug the failing renewal batch.',
          impact: 'Debug logs for one user for 30 minutes; nothing else changes.',
        }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.isError).toBe(true);
        expect(calls.length).toBe(0);
        return text('The user denied turning on debug logging.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'turn on debug logs for me');
    const c = await waitConfirmation(ctx, session.id);
    await ctx.runtime.confirm(session.id, c.confirmationId, 'deny', user.id);
    await waitForIdle(ctx, session.id);
  });

  it('flow_set_active_version is gated and activates the requested version once confirmed', async () => {
    const provider = new FakeProvider([]);
    const calls: unknown[] = [];
    const sf = {
      flowSetActiveVersion: async (_orgId: string, developerName: string, versionNumber: number | null) => {
        calls.push({ developerName, versionNumber });
        return { id: '300x', activeVersionNumber: versionNumber };
      },
    };
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('flow_set_active_version', {
          developerName: 'Contract_Renewal',
          versionNumber: 3,
          reason: 'Roll forward the fixed version.',
          impact: 'Every Contract record save runs version 3 of the flow from now on.',
        }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.isError).toBe(false);
        expect(last.content).toContain('version 3');
        expect(calls).toEqual([{ developerName: 'Contract_Renewal', versionNumber: 3 }]);
        return text('Activated version 3.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'activate version 3 of the renewal flow');
    const c = await waitConfirmation(ctx, session.id);
    expect(c.title).toContain('Activate version 3');
    await ctx.runtime.confirm(session.id, c.confirmationId, 'approve', user.id);
    await waitForIdle(ctx, session.id);
  });
});
