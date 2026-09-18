import { describe, it, expect } from 'vitest';
import { createTranscript } from '../src/lib/transcript.js';
import { flattenRecord } from '../src/lib/soql.js';

describe('transcript reducer', () => {
  it('allows resume to set an optimistic status message', () => {
    const t = createTranscript();

    t.statusMessage = 'Resuming…';

    expect(t.statusMessage).toBe('Resuming…');
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
