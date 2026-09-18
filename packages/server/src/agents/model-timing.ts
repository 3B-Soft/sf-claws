import type { AgentRole, ModelStartedEvent } from '@sf-claws/shared';
import type { z } from 'zod';
import type { LlmProvider, LlmRequest, LlmResponse } from '../ai/types.js';
import { newId } from '../lib/crypto.js';
import type { SessionEventBus } from './events.js';

type Attribution = Pick<z.infer<typeof ModelStartedEvent>, 'agentId' | 'role' | 'phase' | 'purpose' | 'attempt'>;

export function workPhase(role: AgentRole, approved: boolean): Attribution['phase'] {
  if (role === 'researcher' || role === 'analyst') return 'research';
  if (role === 'reviewer') return 'review';
  if (role === 'doc_writer') return 'documentation';
  if (role.endsWith('_builder')) return 'build';
  return approved ? 'build' : 'planning';
}

/** Each provider attempt gets its own span, including retries, fallbacks and failed calls. */
export async function measuredCompletion(
  bus: SessionEventBus,
  sessionId: string,
  attribution: Attribution,
  provider: LlmProvider,
  request: LlmRequest,
): Promise<LlmResponse> {
  const identity = { ...attribution, callId: newId('mc'), modelId: request.model.modelId, provider: request.model.provider };
  bus.emit(sessionId, { type: 'model.started', ...identity });
  const started = performance.now();
  let firstOutputMs: number | null = null;
  const observe = () => {
    firstOutputMs ??= performance.now() - started;
  };
  let response: LlmResponse | undefined;
  try {
    response = await provider.complete({
      ...request,
      onText: (text) => {
        observe();
        request.onText?.(text);
      },
      onThinking: (text) => {
        observe();
        request.onThinking?.(text);
      },
      onToolCall: (call) => {
        observe();
        request.onToolCall?.(call);
      },
    });
    return response;
  } finally {
    bus.emit(sessionId, {
      type: 'model.finished',
      ...identity,
      durationMs: performance.now() - started,
      firstOutputMs,
      outcome: response ? 'completed' : request.signal?.aborted ? 'cancelled' : 'failed',
      usage: response?.usage ?? null,
    });
  }
}
