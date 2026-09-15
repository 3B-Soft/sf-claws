import { describe, it, expect } from 'vitest';
import { createTranscript } from '../src/lib/transcript.js';
import { flattenRecord } from '../src/lib/soql.js';

describe('transcript reducer', () => {
  it('patches the optimistic user bubble instead of showing it twice', () => {
    const t = createTranscript();
    t.addLocalUser('hello');
    t.apply({ type: 'user.message', seq: 1, at: 'now', text: 'hello', userId: 'u1' });
    const users = t.items.filter((i) => i.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ seq: 1, userId: 'u1', local: false });
  });

  it('merges streamed thinking deltas from one agent into one row', () => {
    const t = createTranscript();
    t.apply({ type: 'assistant.thinking', seq: 1, at: 'now', agentId: 'a', text: 'Let me ' });
    t.apply({ type: 'assistant.thinking', seq: 2, at: 'now', agentId: 'a', text: 'check.' });
    t.apply({ type: 'assistant.thinking', seq: 3, at: 'now', agentId: 'b', text: 'Other agent' });
    const rows = t.items.filter((i) => i.kind === 'thinking');
    expect(rows.map((r) => r.text)).toEqual(['Let me check.', 'Other agent']);
  });
});

describe('flattenRecord', () => {
  it('ignores the index Array.prototype.map passes as the second argument', () => {
    const rows = [{ Id: '1', Account: { Name: 'Acme' } }].map(flattenRecord);
    expect(rows[0]).toEqual({ Id: '1', 'Account.Name': 'Acme' });
  });
});
