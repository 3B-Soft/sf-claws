import { describe, it, expect } from 'vitest';
import { SESSION_EVENT_TYPES as SHARED } from '@sf-claws/shared';
import { SESSION_EVENT_TYPES as PANEL } from '../src/lib/transcript.js';

/**
 * The panel subscribes to named SSE events, so an event type missing from its list is never
 * delivered — silently. It had already lost `browser.request`, which is how the agent asks the
 * panel for the user's console and network logs. Importing the shared list here rather than in the
 * panel keeps zod out of the shipped bundle and still fails the build on drift.
 */
describe('session event types', () => {
  it('covers every event the server can send', () => {
    expect([...PANEL].sort()).toEqual([...SHARED].sort());
  });
});
