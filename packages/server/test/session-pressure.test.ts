import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider } from './helpers.js';

describe('context pressure', () => {
  it('warns once per level, in words a user can act on', async () => {
    const ctx = makeContext({ provider: new FakeProvider([]), sf: {} as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });

    ctx.runtime.noteContextPressure(session.id, 50_000, 200_000); // 25% — nothing to say
    ctx.runtime.noteContextPressure(session.id, 156_000, 200_000); // 78% — warning
    ctx.runtime.noteContextPressure(session.id, 158_000, 200_000); // still a warning, not repeated
    ctx.runtime.noteContextPressure(session.id, 186_000, 200_000); // 93% — critical
    ctx.runtime.noteContextPressure(session.id, 190_000, 200_000); // not repeated either

    const events = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'session.context') as any[];
    expect(events.map((e) => e.level)).toEqual(['warning', 'critical']);
    expect(events[0].percent).toBe(78);
    expect(events[0].message).toContain('getting long');
    expect(events[0].message).toContain('compact');
    expect(events[1].message).toContain('next message is likely to be refused');
    expect(events[1].message).toContain('start a new one');
  });
});

describe('compaction on demand', () => {
  it('shrinks the stored conversation and clears the pressure warnings', async () => {
    const ctx = makeContext({ provider: new FakeProvider([]), sf: {} as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro' });
    for (let i = 0; i < 12; i++) {
      ctx.repos.messages.append(session.id, 'orchestrator', 'user', { role: 'user', content: [{ type: 'text', text: `turn ${i} `.repeat(400) }] });
      ctx.repos.messages.append(session.id, 'orchestrator', 'assistant', { role: 'assistant', content: [{ type: 'text', text: `reply ${i} `.repeat(400) }] });
    }
    ctx.runtime.noteContextPressure(session.id, 156_000, 200_000);

    const r = await ctx.runtime.compactSession(session.id);
    expect(r.ok).toBe(true);
    expect(r.afterTokens).toBeLessThan(r.beforeTokens);
    expect(ctx.repos.messages.list(session.id, 'orchestrator').length).toBeLessThan(24);

    // The conversation shrank, so the same warning may legitimately fire again later.
    ctx.runtime.noteContextPressure(session.id, 156_000, 200_000);
    expect(ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'session.context')).toHaveLength(2);
  });
});

describe('stale session spin-down', () => {
  it('spins down an untouched session that still has open todos, and leaves the rest alone', async () => {
    const ctx = makeContext({ provider: new FakeProvider([]), sf: {} as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const stale = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro', title: 'Stale' });
    const done = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'pro', title: 'No open work' });
    ctx.repos.todos.set(stale.id, [{ id: '1', content: 'Add the field', status: 'in_progress' }], 'orchestrator');
    ctx.repos.todos.set(done.id, [{ id: '1', content: 'Add the field', status: 'completed' }], 'orchestrator');

    expect(ctx.runtime.sweepIdleSessions(Date.now())).toBe(0); // both were just touched
    // A day later: only the abandoned session with open work is spun down.
    expect(ctx.runtime.sweepIdleSessions(Date.now() + 24 * 60 * 60 * 1000)).toBe(1);
    expect(ctx.repos.sessions.byId(stale.id)!.status).toBe('cancelled');
    expect(ctx.repos.sessions.byId(done.id)!.status).toBe('idle');

    const status = (ctx.repos.events.listAfter(stale.id).filter((e) => e.type === 'session.status') as any[]).at(-1)!;
    expect(status.message).toContain('Spun down after 12 hours without activity');
    expect(status.message).toContain('Resume');

    // Still resumable: a spun-down session is not a dead one.
    expect(() => ctx.runtime.resume(stale.id, user.id)).not.toThrow();
  });
});
