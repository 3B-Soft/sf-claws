import { describe, it, expect } from 'vitest';
import { createTranscript, turnAnswered } from '../src/lib/transcript.js';

/**
 * The "Was this session helpful?" card keyed off `idle && items.length > 0`, and a fresh session
 * already has a "Session created" status item — so it asked before the user had typed anything.
 */
describe('turnAnswered', () => {
  it('is false for a new session with only the created status', () => {
    const t = createTranscript();
    t.apply({ type: 'session.status', seq: 1, status: 'idle', message: 'Session created' });
    expect(t.items).toHaveLength(1);
    expect(turnAnswered(t.items)).toBe(false);
  });

  it('is false while the reply to the latest message is missing or still streaming', () => {
    const t = createTranscript();
    t.addLocalUser('Add a field');
    expect(turnAnswered(t.items)).toBe(false);
    t.apply({ type: 'assistant.delta', seq: 2, agentId: 'a', messageId: 'm1', delta: 'Work' });
    expect(turnAnswered(t.items)).toBe(false);
  });

  it('is true once the reply finishes, and false again after the next message', () => {
    const items = [{ kind: 'user' }, { kind: 'assistant', streaming: false }];
    expect(turnAnswered(items)).toBe(true);
    expect(turnAnswered([...items, { kind: 'user' }])).toBe(false);
  });
});
