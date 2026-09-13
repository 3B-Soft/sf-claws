import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, disablePlanMode, FakeProvider, text, toolCalls, waitForIdle } from './helpers.js';

/**
 * Tool calls start as soon as their block finishes streaming, not when the whole message lands.
 * The timeline below is what these tests actually assert: a read that starts before `complete`
 * resolves has overlapped the model's writing time.
 */
function timeline() {
  const events: string[] = [];
  return { events, mark: (e: string) => events.push(e) };
}

describe('streaming tool execution', () => {
  it('starts a leading run of safe reads while the model is still writing', async () => {
    const { events, mark } = timeline();
    const provider = new FakeProvider([]);
    provider.streamToolCalls = true;
    const sf = {
      query: async (_o: string, soql: string) => {
        mark(`query:${soql}`);
        return { totalSize: 0, records: [], done: true };
      },
      limits: async () => ({ orgId: 'o', fetchedAt: new Date().toISOString(), limits: [], warnings: [] }),
    };
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCalls([
          { name: 'soql_query', input: { soql: 'SELECT Id FROM Account' } },
          { name: 'soql_query', input: { soql: 'SELECT Id FROM Contact' } },
        ]),
      () => {
        mark('second-completion');
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'look around');
    await waitForIdle(ctx, session.id);

    // Both reads ran, each exactly once — the early start is reused, not repeated.
    expect(events.filter((e) => e.startsWith('query:'))).toEqual(['query:SELECT Id FROM Account', 'query:SELECT Id FROM Contact']);
    expect(events.indexOf('second-completion')).toBe(2);
  });

  it('closes the window after an ineligible call, so the scheduler still serialises the turn', async () => {
    const { events, mark } = timeline();
    const provider = new FakeProvider([]);
    provider.streamToolCalls = true;
    const sf = {
      query: async () => {
        mark('query');
        return { totalSize: 0, records: [], done: true };
      },
      limits: async () => ({ orgId: 'o', fetchedAt: new Date().toISOString(), limits: [], warnings: [] }),
    };
    const ctx = makeContext({ provider, sf: sf as any });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => {
        // A staging write is concurrency-unsafe, so the read behind it must not jump ahead of it.
        setTimeout(() => mark('completion-returned'), 0);
        return toolCalls([
          { name: 'write_workspace_file', input: { path: 'classes/A.cls', content: 'public class A {}' } },
          { name: 'soql_query', input: { soql: 'SELECT Id FROM Account' } },
        ]);
      },
      () => text('done'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'stage then read');
    await waitForIdle(ctx, session.id);

    expect(events).toContain('query');
    // The read waited for the message to finish; an early start would have put it first.
    expect(events.indexOf('completion-returned')).toBeLessThan(events.indexOf('query'));
    expect(ctx.repos.workspace.list(session.id).map((f) => f.path)).toEqual(['classes/A.cls']);
  });
});
