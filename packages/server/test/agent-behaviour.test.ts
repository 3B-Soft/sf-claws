import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, waitForIdle, disablePlanMode, nextEvent } from './helpers.js';
import type { LlmResponse } from '../src/ai/types.js';
import { LlmError } from '../src/ai/types.js';
import { PLAN_REVISIONS_NOTE } from '../src/agents/runtime.js';

/**
 * These exercise the new runtime behaviour through the real agent loop rather than calling the
 * pieces directly. The unit tests prove the algorithms; these prove the wiring, which is where
 * this kind of change actually breaks.
 */

const NS = 'http://soap.sforce.com/2006/04/metadata';
const fieldXml = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="${NS}"><fullName>A__c</fullName><label>A</label><type>Date</type></CustomField>`;

/** Several tool calls in one assistant message, to exercise scheduling. */
const parallelCalls = (calls: { name: string; input: unknown }[]): LlmResponse => ({
  content: calls.map((c, i) => ({ type: 'tool_use' as const, id: `tu_${i}_${Math.random().toString(36).slice(2)}`, name: c.name, input: c.input })),
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
});

describe('plan mode', () => {
  it('refuses to delegate to a builder before a plan is approved, then allows it after', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });

    provider.script = [
      () => toolCall('run_subagent', { role: 'metadata_builder', objective: 'build it' }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as { content: string; isError: boolean };
        expect(last.isError).toBe(true);
        expect(last.content).toContain('no approved plan');
        return toolCall('submit_plan', {
          summary: 'Add field A',
          markdown: '- Add A__c to Account',
          impact: 'Sales users see one new field on Account; no existing data changes.',
        });
      },
      () => text('Plan approved, proceeding.'),
    ];

    ctx.runtime.startTurn(session.id, user.id, 'add a field');
    const plan = await nextEvent(ctx, session.id, 'plan.submitted');
    await ctx.runtime.confirm(session.id, plan.confirmationId, 'approve', user.id);
    await waitForIdle(ctx, session.id);

    const s = ctx.repos.sessions.byId(session.id)!;
    expect(s.planApprovedAt).toBeTruthy();
    expect(s.planMarkdown).toContain('A__c');
  });

  it('lets a single simple component through without a plan, because a round trip would be noise', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { readComponent: async () => [] } as never });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('write_workspace_file', { path: 'objects/Account/fields/A__c.field-meta.xml', content: fieldXml }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as { isError: boolean };
        expect(last.isError).toBe(false);
        return text('Staged the field.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add field A');
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.workspace.list(session.id)).toHaveLength(1);
  });

  it('takes a revision when the user asks for changes, without losing the session', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('submit_plan', { summary: 'v1', markdown: 'first attempt', impact: 'Sales users see one new field on Account; no existing data changes.' }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as { content: string };
        expect(last.content).toContain('CHANGES');
        return text('Understood, I will revise.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'do something big');
    const plan = await nextEvent(ctx, session.id, 'plan.submitted');
    await ctx.runtime.confirm(session.id, plan.confirmationId, 'changes', user.id, 'Use a formula field instead');
    await waitForIdle(ctx, session.id);
    const s = ctx.repos.sessions.byId(session.id)!;
    expect(s.planApprovedAt).toBeFalsy();
    expect(s.planRevision).toBe(1);
    // The rejection is kept for the doc writer's Lesson section and the next session's planner.
    const note = ctx.repos.notes.byTitle(session.id, PLAN_REVISIONS_NOTE)!;
    expect(note).toBeTruthy();
    expect(note.tags).toContain('lesson');
    expect(note.content).toContain('Revision 1 REJECTED');
    expect(note.content).toContain('Use a formula field instead');
    expect(note.content).toContain('v1');
  });
});

describe('ask_user', () => {
  it('round-trips a chosen option back to the agent', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('ask_user', {
          question: 'Which object?',
          options: [
            { id: 'acct', label: 'Account' },
            { id: 'opp', label: 'Opportunity' },
          ],
        }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as { content: string };
        expect(last.content).toContain('Opportunity');
        return text('Working on Opportunity.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add a field somewhere');
    const q = await nextEvent(ctx, session.id, 'confirmation.requested');
    expect(q.kind).toBe('question');
    await ctx.runtime.confirm(session.id, q.confirmationId, 'opp', user.id);
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('idle');
  });

  it('passes a typed answer through in preference to the option label', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('ask_user', { question: 'Which object?', options: [{ id: 'acct', label: 'Account' }] }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as { content: string };
        expect(last.content).toContain('Custom_Thing__c');
        return text('Using the custom object.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add a field');
    const q = await nextEvent(ctx, session.id, 'confirmation.requested');
    await ctx.runtime.confirm(session.id, q.confirmationId, 'acct', user.id, 'Custom_Thing__c');
    await waitForIdle(ctx, session.id);
  });

  it('rejects a question with no options rather than stalling the user', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => toolCall('ask_user', { question: 'What do you think?', options: [] }),
      (req) => {
        const last = req.messages.at(-1)!.content[0] as { content: string; isError: boolean };
        expect(last.isError).toBe(true);
        expect(last.content).toContain('at least one option');
        return text('Let me be more concrete.');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'help');
    await waitForIdle(ctx, session.id);
  });
});

describe('spend ceilings', () => {
  it('stops the run before the call that would cross the ceiling, and says why', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org, client } = await seedClientOrgUser(ctx);
    // A ceiling low enough that the very first completion's projected cost exceeds it.
    ctx.repos.policies.set(`client:${client.id}`, { maxSessionCostUsd: 0.0001, costCeilingDocReserveUsd: 0, requirePlanApproval: 'never' }, 'test');
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    // The ceiling is checked before each call with the call's projected price, so a call that
    // would cross it is refused before any money is spent — including the very first one.
    let calls = 0;
    provider.script = [
      () => {
        calls++;
        return toolCall('todo_read', {});
      },
      () => {
        calls++;
        return text('should never run');
      },
    ];

    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);

    expect(calls).toBe(0);
    const limit = ctx.repos.events.listAfter(session.id).find((e) => e.type === 'session.limit');
    expect(limit).toBeTruthy();
    expect((limit as unknown as { scope: string }).scope).toBe('session');
    expect((limit as unknown as { message: string }).message).toContain('would be crossed');
    expect(ctx.repos.sessions.byId(session.id)!.costUsd).toBe(0);
  });

  it('does not interfere when no ceiling is configured', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [() => text('done')];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.events.listAfter(session.id).some((e) => e.type === 'session.limit')).toBe(false);
  });
});

describe('tool scheduling in a real turn', () => {
  it('runs read-only calls together and serialises writes to the same path', async () => {
    const provider = new FakeProvider([]);
    const order: string[] = [];
    const ctx = makeContext({
      provider,
      sf: {
        query: async () => {
          order.push('query');
          await new Promise((r) => setTimeout(r, 15));
          return { totalSize: 0, done: true, records: [], columns: [] };
        },
        describe: async () => {
          order.push('describe');
          await new Promise((r) => setTimeout(r, 5));
          return { name: 'Account', fields: [] };
        },
        readComponent: async () => [],
      } as never,
    });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });

    provider.script = [
      // Two reads (safe, parallel) plus two writes to one path (unsafe, must serialise).
      () =>
        parallelCalls([
          { name: 'soql_query', input: { soql: 'SELECT Id FROM Account' } },
          { name: 'describe_sobject', input: { sobject: 'Account' } },
          { name: 'write_workspace_file', input: { path: 'objects/Account/fields/A__c.field-meta.xml', content: fieldXml } },
          {
            name: 'write_workspace_file',
            input: { path: 'objects/Account/fields/A__c.field-meta.xml', content: fieldXml.replace('<label>A</label>', '<label>B</label>') },
          },
        ]),
      () => text('done'),
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);

    // The slower read still finished first because the two ran concurrently.
    expect(order).toEqual(['query', 'describe']);
    // Last write wins deterministically rather than racing.
    const file = ctx.repos.workspace.get(session.id, 'objects/Account/fields/A__c.field-meta.xml')!;
    expect(file.content).toContain('<label>B</label>');
  });

  it('returns results in the order the model emitted them', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({
      provider,
      sf: {
        query: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { totalSize: 1, done: true, records: [{ Id: 'slow' }], columns: ['Id'] };
        },
        describe: async () => ({ name: 'FastObject', fields: [] }),
      } as never,
    });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        parallelCalls([
          { name: 'soql_query', input: { soql: 'SELECT Id FROM Account' } },
          { name: 'describe_sobject', input: { sobject: 'FastObject' } },
        ]),
      (req) => {
        const results = req.messages.at(-1)!.content as { content: string }[];
        // Slow-but-first stays first: the model's reasoning depends on the order it asked in.
        expect(results[0].content).toContain('slow');
        expect(results[1].content).toContain('FastObject');
        return text('done');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
  });
});

describe('provider failure handling', () => {
  it('retries a retryable error and carries on', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    let attempts = 0;
    provider.script = [
      () => {
        attempts++;
        throw new LlmError('rate limited', 'anthropic', true, 429, { retryAfterSeconds: 0 });
      },
      () => {
        attempts++;
        return text('recovered');
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    expect(attempts).toBe(2);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('idle');
  });

  it('gives up on a non-retryable error with a clear session error', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () => {
        throw new LlmError('API key is invalid', 'anthropic', false, 401);
      },
    ];
    ctx.runtime.startTurn(session.id, user.id, 'go');
    await waitForIdle(ctx, session.id);
    const errors = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'session.error');
    expect(errors.some((e) => (e as { message: string }).message.includes('API key is invalid'))).toBe(true);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('failed');
  });
});

describe('interrupted conversations', () => {
  it('repairs a dangling tool_use so a resumed session is replayable', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: {} as never });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });

    // Simulate the crash window: an assistant message with a tool_use, and no result ever stored.
    ctx.repos.messages.append(session.id, 'orchestrator', 'user', { role: 'user', content: [{ type: 'text', text: 'go' }] });
    ctx.repos.messages.append(session.id, 'orchestrator', 'assistant', {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_orphan', name: 'soql_query', input: { soql: 'SELECT Id FROM Account' } }],
    });

    provider.script = [
      (req) => {
        // Every tool_use must be answered or the provider rejects the request outright.
        const ids = new Set<string>();
        const answered = new Set<string>();
        for (const m of req.messages) {
          for (const b of m.content) {
            if (b.type === 'tool_use') ids.add(b.id);
            if (b.type === 'tool_result') answered.add(b.toolUseId);
          }
        }
        expect([...ids].every((id) => answered.has(id))).toBe(true);
        return text('Recovered and continuing.');
      },
    ];

    ctx.runtime.resume(session.id, user.id);
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.sessions.byId(session.id)!.status).toBe('idle');
  });

  it('marks in-flight todos blocked when a run is cancelled', async () => {
    const ctx = makeContext({ provider: new FakeProvider([]), sf: {} as never });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.todos.set(
      session.id,
      [
        { id: 't1', content: 'Doing this', status: 'in_progress' },
        { id: 't2', content: 'Later', status: 'pending' },
      ],
      'orchestrator',
    );

    ctx.runtime.startTurn(session.id, user.id, 'go');
    ctx.runtime.cancel(session.id, user.id);
    await waitForIdle(ctx, session.id);

    const todos = ctx.repos.todos.get(session.id);
    expect(todos.find((t) => t.id === 't1')!.status).toBe('blocked');
    // A pending item was never started, so it stays pending rather than being falsely blocked.
    expect(todos.find((t) => t.id === 't2')!.status).toBe('pending');
  });
});
