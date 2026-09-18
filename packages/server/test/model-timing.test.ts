import { describe, expect, it } from 'vitest';
import { SessionEvent } from '@sf-claws/shared';
import { measuredCompletion } from '../src/agents/model-timing.js';
import { makeContext, seedClientOrgUser, FakeProvider, text, waitForIdle } from './helpers.js';

describe('model timing', () => {
  it('records per-attempt identity and first output without changing callbacks or cumulative billing', async () => {
    const provider = new FakeProvider([
      (req) => {
        req.onText?.('hello');
        return text('hello');
      },
    ]);
    const ctx = makeContext({ provider, sf: {} as never });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    ctx.runtime.startTurn(session.id, user.id, 'hello');
    await waitForIdle(ctx, session.id);
    const events = ctx.repos.events.listAfter(session.id);
    const start = events.find((e) => e.type === 'model.started')!;
    const finish = events.find((e) => e.type === 'model.finished')!;
    expect(SessionEvent.safeParse(start).success).toBe(true);
    expect(SessionEvent.safeParse(finish).success).toBe(true);
    if (start.type !== 'model.started' || finish.type !== 'model.finished') throw new Error('Missing timing');
    expect(finish.callId).toBe(start.callId);
    expect(finish).toMatchObject({
      agentId: 'orchestrator',
      phase: 'planning',
      purpose: 'turn',
      outcome: 'completed',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(finish.firstOutputMs).not.toBeNull();
    expect(ctx.repos.sessions.byId(session.id)!.outputTokens).toBe(20);
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'hello')).toBe(true);
  });

  it('records failures and cancellation with unknown usage and propagates the original error', async () => {
    const failure = new Error('provider unavailable');
    const provider = new FakeProvider([
      () => {
        throw failure;
      },
      () => {
        throw failure;
      },
    ]);
    const ctx = makeContext({ provider });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    const model = ctx.ai.resolve('orchestrator', user.id).model;
    const abort = new AbortController();
    for (const attempt of [1, 2]) {
      if (attempt === 2) abort.abort();
      await expect(
        measuredCompletion(
          ctx.runtime.bus,
          session.id,
          {
            agentId: 'worker',
            role: 'apex_builder',
            phase: 'build',
            purpose: 'turn',
            attempt,
          },
          provider,
          { model, system: '', messages: [], tools: [], effort: 'low', signal: abort.signal },
        ),
      ).rejects.toBe(failure);
    }
    const finishes = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'model.finished');
    expect(finishes.map((e) => e.outcome)).toEqual(['failed', 'cancelled']);
    expect(finishes.map((e) => e.usage)).toEqual([null, null]);
    expect(new Set(finishes.map((e) => e.callId)).size).toBe(2);
  });
});
