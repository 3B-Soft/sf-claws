import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, waitForIdle } from './helpers.js';

describe('completion drive', () => {
  it('nudges the orchestrator when it stops with open todos, and stops nudging when it asks the user a question', async () => {
    const provider = new FakeProvider([]);
    const ctx = makeContext({ provider, sf: { limits: async () => ({ orgId: 'o', fetchedAt: new Date().toISOString(), limits: [], warnings: [] }) } as any });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    provider.script = [
      () =>
        toolCall('todo_write', {
          items: [
            { id: 't1', content: 'Look up field', status: 'completed' },
            { id: 't2', content: 'Add field', status: 'pending' },
          ],
        }),
      () => text('Found the field. I will add it later.'), // stops with open item -> nudge
      (req) => {
        expect((req.messages.at(-1)!.content[0] as any).text).toContain('[Harness] Your todo list still has open items');
        return text('QUESTION FOR YOU: which data type should the field have?');
      },
      // auto documentation (meaningful turn) — not required here (only 1 tool call), so nothing more
    ];
    ctx.runtime.startTurn(session.id, user.id, 'add field');
    await waitForIdle(ctx, session.id);
    expect(provider.requests).toHaveLength(3);
    const msgs = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'assistant.message') as any[];
    expect(msgs.at(-1).text).toContain('QUESTION FOR YOU');
  });
});
