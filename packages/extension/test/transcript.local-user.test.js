import { describe, it, expect } from 'vitest';
import { createTranscript } from '../src/lib/transcript.js';

/**
 * The panel shows a sent message at once, then the server echoes it as `user.message`. The echo
 * must replace the optimistic copy: it used to be appended beside it, so every message the user
 * sent showed up twice — most visibly when the turn then failed and nothing else followed it.
 */
describe('optimistic user messages', () => {
  const users = (t) => t.items.filter((i) => i.kind === 'user');

  it('reconciles the echo with the local copy instead of adding a second bubble', () => {
    const t = createTranscript();
    t.addLocalUser('Add a field');
    t.apply({ type: 'user.message', seq: 3, at: '2026-09-15T00:00:00Z', userId: 'u1', text: 'Add a field' });
    t.apply({ type: 'session.error', seq: 4, agentId: 'orchestrator', message: 'provider 400', recoverable: false });
    expect(users(t)).toHaveLength(1);
    expect(users(t)[0]).toMatchObject({ seq: 3, userId: 'u1', local: false });
    // Re-delivery of the same event (SSE replay after a reconnect) is still ignored.
    expect(t.apply({ type: 'user.message', seq: 3, text: 'Add a field' })).toBe(false);
    expect(users(t)).toHaveLength(1);
  });

  it('pairs repeated identical messages one-to-one', () => {
    const t = createTranscript();
    t.addLocalUser('retry');
    t.apply({ type: 'user.message', seq: 1, text: 'retry' });
    t.addLocalUser('retry');
    t.apply({ type: 'user.message', seq: 5, text: 'retry' });
    expect(users(t).map((u) => u.seq)).toEqual([1, 5]);
  });

  it('keeps a message sent from elsewhere and drops a local copy the server rejected', () => {
    const t = createTranscript();
    t.apply({ type: 'user.message', seq: 1, text: 'from another device' });
    const key = t.addLocalUser('rejected');
    t.removeLocalUser(key);
    expect(users(t).map((u) => u.text)).toEqual(['from another device']);
    expect(t.items.map((i) => i.key)).not.toContain(key);
  });
});
