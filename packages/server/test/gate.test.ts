import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, waitForIdle } from './helpers.js';

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

describe('allow list + approval gate, todo, scratchpad, recovery', () => {
  it('shows reason + command, executes on approve, remembers "allow for session", refuses off-list commands', async () => {
    const provider = new FakeProvider([]);
    const executed: string[] = [];
    const sf = {
      executeAnonymous: async (_o: string, apex: string) => {
        executed.push(apex);
        return { compiled: true, success: true, line: null, column: null, compileProblem: null, exceptionMessage: null, exceptionStackTrace: null };
      },
      runTests: async () => {
        executed.push('tests');
        return [];
      },
      limits: async () => ({
        orgId: 'o',
        fetchedAt: new Date().toISOString(),
        limits: [{ name: 'DailyApiRequests', max: 100, remaining: 10, usedPercent: 90, warning: true }],
        warnings: ['DailyApiRequests: 90% used'],
      }),
    };
    const ctx = makeContext({ provider, sf: sf as any });
    ctx.repos.policies.set('global', { impactAllowList: ['execute_anonymous_apex', 'run_apex_tests', 'deploy'], sessionAllowable: ['run_apex_tests'] }, 'u');
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      (req) => {
        expect(req.messages[0].content[0]).toMatchObject({ type: 'text' });
        expect((req.messages[0].content[0] as any).text).toContain('org limits approaching');
        return toolCall('execute_anonymous_apex', {
          apex: 'System.debug(1);',
          reason: 'Check the debug output of the renewal job settings for the user.',
          impact: 'Reads debug output only; no users, automations or records are affected.',
        });
      },
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.isError).toBe(false);
        return toolCall('run_apex_tests', {
          classNames: ['FooTest'],
          reason: 'Verify current behaviour before changing it.',
          impact: 'Runs existing tests in the sandbox; no users or records are affected.',
        });
      },
      () =>
        toolCall('run_apex_tests', {
          classNames: ['FooTest'],
          reason: 'Second run of the same class should not prompt again.',
          impact: 'Runs existing tests in the sandbox; no users or records are affected.',
        }),
      () =>
        toolCall('create_record', {
          sobject: 'Account',
          fields: { Name: 'x' },
          reason: 'Create a test account for verification purposes.',
          impact: 'Adds one Account record visible to every sales user.',
        }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toMatch(/POLICY VIOLATION|not on the allow list/);
        return toolCall('execute_anonymous_apex', {
          apex: 'delete [SELECT Id FROM Account];',
          reason: 'Cleanup all accounts as requested by the user for the sandbox reset.',
        });
      },
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('POLICY VIOLATION');
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'debug');
    const c1 = await waitConfirmation(ctx, session.id);
    expect(c1.kind).toBe('command');
    expect(c1.command.name).toBe('execute_anonymous_apex');
    expect(c1.command.input.apex).toBe('System.debug(1);');
    expect(c1.description).toContain('renewal job');
    expect(c1.options.map((o: any) => o.id)).toEqual(['approve', 'deny']); // apex not session-allowable
    await ctx.runtime.confirm(session.id, c1.confirmationId, 'approve', user.id);
    const c2 = await waitConfirmation(ctx, session.id);
    expect(c2.command.name).toBe('run_apex_tests');
    expect(c2.options.map((o: any) => o.id)).toEqual(['approve', 'approve_session', 'deny']);
    await ctx.runtime.confirm(session.id, c2.confirmationId, 'approve_session', user.id);
    await waitForIdle(ctx, session.id);
    expect(executed).toEqual(['System.debug(1);', 'tests', 'tests']);
    // The grant is scoped to what was approved, not to the whole command.
    expect(ctx.repos.permissions.list(session.id).map((p) => p.command)).toEqual(['run_apex_tests(FooTest)']);
    const evs = ctx.repos.events.listAfter(session.id);
    expect(evs.some((e) => e.type === 'org.limits')).toBe(true);
    expect(evs.filter((e) => e.type === 'confirmation.requested')).toHaveLength(2);
  });

  it('deny stops the command; todo and scratchpad persist; snapshot + resume work', async () => {
    const provider = new FakeProvider([]);
    const executed: string[] = [];
    const sf = {
      executeAnonymous: async (_o: string, apex: string) => {
        executed.push(apex);
        return { compiled: true, success: true };
      },
      limits: async () => ({ orgId: 'o', fetchedAt: new Date().toISOString(), limits: [], warnings: [] }),
    };
    const ctx = makeContext({ provider, sf: sf as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('todo_write', {
          items: [
            { id: 't1', content: 'Investigate', status: 'in_progress' },
            { id: 't2', content: 'Fix', status: 'pending' },
          ],
        }),
      () => toolCall('scratchpad_write', { title: 'Findings', content: 'Field X is missing FLS', tags: ['fls'] }),
      () =>
        toolCall('execute_anonymous_apex', {
          apex: 'System.debug(2);',
          reason: 'Inspect the scheduled jobs configured in the org.',
          impact: 'Reads scheduled job configuration only; nothing is changed.',
        }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as any;
        expect(last.content).toContain('DENIED');
        return toolCall('todo_write', {
          items: [
            { id: 't1', content: 'Investigate', status: 'completed' },
            { id: 't2', content: 'Fix', status: 'pending' },
          ],
        });
      },
      () => text('QUESTION FOR YOU: should I proceed with the fix?'),
      // auto-doc (meaningful: >=4 tool calls)
      () => toolCall('write_documentation', { title: 'd', summary: 's', technical: 't', endUser: 'e' }),
      () => text('ok'),
      // resume turn
      (req) => {
        const t = (req.messages.at(-1)!.content[0] as any).text;
        expect(t).toContain('[Harness recovery]');
        expect(t).toContain('[pending] Fix');
        expect(t).toContain('Findings');
        return toolCall('scratchpad_read', { title: 'Findings' });
      },
      (req) => {
        expect((req.messages.at(-1)!.content[0] as any).content).toContain('missing FLS');
        return text('resumed');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    const c = await waitConfirmation(ctx, session.id);
    await ctx.runtime.confirm(session.id, c.confirmationId, 'deny', user.id);
    await waitForIdle(ctx, session.id);
    expect(executed).toEqual([]);
    expect(ctx.repos.todos.get(session.id).map((t) => t.status)).toEqual(['completed', 'pending']);
    expect(ctx.repos.notes.list(session.id)[0].title).toBe('Findings');
    const snap = ctx.runtime.snapshot(session.id);
    expect(snap.todos).toHaveLength(2);
    expect(snap.notes).toHaveLength(1);
    expect(snap.events.length).toBeGreaterThan(5);
    expect(snap.running).toBe(false);
    // simulate crash recovery marking
    ctx.repos.sessions.update(session.id, { status: 'running' });
    ctx.runtime.recoverOnBoot();
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('failed');
    ctx.runtime.resume(session.id, user.id);
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('idle');
  });

  it('enforces scoped rules end to end: an allowed sObject prompts, an unlisted one is refused, and deny beats a session grant', async () => {
    const provider = new FakeProvider([]);
    const updated: string[] = [];
    const sf = {
      updateRecord: async (_o: string, sobject: string, id: string) => {
        updated.push(`${sobject}/${id}`);
      },
      deleteRecord: async () => {
        updated.push('deleted');
      },
      limits: async () => ({ orgId: 'o', fetchedAt: new Date().toISOString(), limits: [], warnings: [] }),
    };
    const ctx = makeContext({ provider, sf: sf as any });
    ctx.repos.policies.set(
      'global',
      {
        allowDataModification: true,
        impactAllowList: ['update_record(Account)', 'delete_record'],
        impactDenyList: ['delete_record(Account)'],
        sessionAllowable: ['update_record'],
      },
      'u',
    );
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('update_record', {
          sobject: 'Account',
          id: '001a',
          fields: { Name: 'x' },
          reason: 'Fix the account name the user reported as wrong.',
          impact: 'Renames one Account record; everyone who views that account sees the new name.',
        }),
      (req) => {
        expect((req.messages.at(-1)!.content[0] as any).isError).toBe(false);
        return toolCall('update_record', {
          sobject: 'Opportunity',
          id: '006a',
          fields: { Name: 'y' },
          reason: 'Rename the opportunity to match the account.',
          impact: 'Renames one Opportunity record; sales users see the new name.',
        });
      },
      (req) => {
        // Refused by scope, not by the user: no confirmation card was ever raised for it.
        expect((req.messages.at(-1)!.content[0] as any).content).toContain('not covered by any allow rule');
        return toolCall('delete_record', {
          sobject: 'Account',
          id: '001a',
          reason: 'Remove the duplicate account record the user pointed at.',
          impact: 'Deletes one duplicate Account and anything related to it.',
        });
      },
      (req) => {
        expect((req.messages.at(-1)!.content[0] as any).content).toContain('explicitly denied');
        return toolCall('delete_record', {
          sobject: 'Contact',
          id: '003a',
          reason: 'Remove the duplicate contact record the user pointed at.',
          impact: 'Deletes one duplicate Contact and anything related to it.',
        });
      },
      () => text('done'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'clean up the duplicates');
    const c1 = await waitConfirmation(ctx, session.id);
    expect(c1.command.name).toBe('update_record');
    // sessionAllowable says update_record, and the allow rule scopes it to Account — the grant can
    // never be wider than the rule that permitted the call.
    expect(c1.options.map((o: any) => o.id)).toEqual(['approve', 'approve_session', 'deny']);
    await ctx.runtime.confirm(session.id, c1.confirmationId, 'approve', user.id);
    const c2 = await waitConfirmation(ctx, session.id);
    expect(c2.command.name).toBe('delete_record');
    expect(c2.command.input.sobject).toBe('Contact');
    await ctx.runtime.confirm(session.id, c2.confirmationId, 'approve', user.id);
    await waitForIdle(ctx, session.id);

    expect(updated).toEqual(['Account/001a', 'deleted']);
    const blocked = ctx.repos.events.listAfter(session.id).filter((e: any) => e.type === 'policy.blocked');
    expect(blocked.map((e: any) => e.rule)).toEqual(['impactAllowList', 'impactDenyList']);
  });
});
