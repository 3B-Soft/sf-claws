import { describe, it, expect } from 'vitest';
import { createTranscript, groupThread } from '../src/lib/transcript.js';
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

describe("question answered in the user's own words", () => {
  it('shows the typed answer, not the option id, once resolved', () => {
    const t = createTranscript();
    t.apply({
      type: 'confirmation.requested',
      seq: 1,
      confirmationId: 'c1',
      kind: 'question',
      title: 'Which object?',
      options: [{ id: 'acct', label: 'Account' }],
    });
    t.apply({ type: 'confirmation.resolved', seq: 2, confirmationId: 'c1', optionId: 'custom', byUserId: 'u', answerText: 'Custom_Thing__c' });
    const card = t.items.find((i) => i.kind === 'confirmation');
    expect(card.resolved).toBe(true);
    expect(card.resolvedLabel).toBe('Custom_Thing__c');
  });
});

describe('thread grouping', () => {
  it('folds activity between user-facing items into one card', () => {
    const g = groupThread(
      [
        { key: 'u1', kind: 'user', text: 'hi' },
        { key: 'th1', kind: 'thinking', text: 'hmm' },
        { key: 'x1', kind: 'unknown', type: 'model.started' },
        { key: 't1', kind: 'tool', tool: 'grep_repo' },
        { key: 'a1', kind: 'assistant', text: 'Done.' },
        { key: 't2', kind: 'tool', tool: 'read_repo_file' },
      ],
      true,
    );
    expect(g.map((x) => x.key)).toEqual(['u1', 'activity-th1', 'a1', 'activity-t2']);
    expect(g[1].items).toHaveLength(3);
    expect(g[1].running).toBeUndefined();
    expect(g[3].running).toBe(true);
  });

  it('drops a finished group that holds only lifecycle events', () => {
    const g = groupThread([
      { key: 'a1', kind: 'assistant', text: 'Done.' },
      { key: 's1', kind: 'status', status: 'completed' },
      { key: 'x1', kind: 'unknown', type: 'model.finished' },
    ]);
    expect(g.map((x) => x.key)).toEqual(['a1']);
  });
});
