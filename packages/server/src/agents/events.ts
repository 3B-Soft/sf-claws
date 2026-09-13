import type { SessionEvent } from '@sf-claws/shared';
import type { Repos } from '../db/repos/index.js';

type Listener = (ev: SessionEvent) => void;
type Distribute<E> = E extends SessionEvent ? Omit<E, 'seq' | 'sessionId' | 'at'> : never;
export type EventInput = Distribute<SessionEvent>;

/** Ephemeral event types are broadcast but not persisted (history replays assistant.message instead). */
const EPHEMERAL = new Set<SessionEvent['type']>(['assistant.delta', 'assistant.thinking']);

export class SessionEventBus {
  private listeners = new Map<string, Set<Listener>>();
  private seqs = new Map<string, number>();
  constructor(private repos: Repos) {}

  emit(sessionId: string, ev: EventInput): SessionEvent {
    const seq = this.next(sessionId);
    const full = { ...ev, seq, sessionId, at: new Date().toISOString() } as SessionEvent;
    if (!EPHEMERAL.has(full.type)) this.repos.events.append(sessionId, seq, full);
    for (const l of this.listeners.get(sessionId) ?? []) {
      try {
        l(full);
      } catch {
        /* listener errors never break the loop */
      }
    }
    return full;
  }

  private next(sessionId: string): number {
    const cur = this.seqs.get(sessionId) ?? this.repos.events.lastSeq(sessionId);
    const n = cur + 1;
    this.seqs.set(sessionId, n);
    return n;
  }

  /** Live listeners for a session; a completed turn must leave none of its own behind. */
  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }

  subscribe(sessionId: string, l: Listener): () => void {
    if (!this.listeners.has(sessionId)) this.listeners.set(sessionId, new Set());
    this.listeners.get(sessionId)!.add(l);
    return () => {
      this.listeners.get(sessionId)?.delete(l);
    };
  }
}
