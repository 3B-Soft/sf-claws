import type { AiModel, AiProvider } from '@sf-claws/shared';

/**
 * Marks the end of the cacheable half of a system prompt. The prompt builder puts everything stable
 * for the life of a session above it and everything volatile below; a provider that supports manual
 * cache breakpoints splits the system text here and caches only the half that does not change.
 */
export const SYSTEM_CACHE_BOUNDARY = '<!-- session-specific context below -->';

/** The system prompt as two halves. Text before the boundary is cacheable, text after it is not. */
export function splitSystemPrompt(system: string): { stable: string; dynamic: string } {
  const at = system.indexOf(SYSTEM_CACHE_BOUNDARY);
  if (at < 0) return { stable: system, dynamic: '' };
  return { stable: system.slice(0, at).trimEnd(), dynamic: system.slice(at + SYSTEM_CACHE_BOUNDARY.length).trimStart() };
}

/** Provider-neutral content blocks. */
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'thinking'; text: string };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmBlock[];
  /** Provider-specific raw assistant content (e.g. Anthropic thinking blocks with signatures) to replay verbatim on the same model. */
  raw?: { provider: AiProvider; modelId: string; content: unknown };
}

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmRequest {
  model: AiModel;
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens?: number;
  effort: Effort;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /**
   * Fired as soon as a tool_use block has finished streaming, before the rest of the message
   * arrives. Providers that cannot tell when a block is complete simply never call it — the caller
   * must treat this as an optimisation and still handle every call from the finished response.
   */
  onToolCall?: (call: { id: string; name: string; input: unknown }) => void;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface LlmResponse {
  content: LlmBlock[];
  raw?: unknown;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  refusalReason?: string | null;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly provider: AiProvider;
  complete(req: LlmRequest): Promise<LlmResponse>;
  test(modelId?: string): Promise<{ ok: boolean; message: string }>;
}

export class LlmError extends Error {
  /** Seconds the provider asked us to wait (`Retry-After`), when it said so. */
  retryAfterSeconds?: number | null;
  /** The request exceeded the model's context window — compaction may fix it, retrying will not. */
  contextOverflow?: boolean;
  constructor(
    message: string,
    public provider: AiProvider,
    public retryable: boolean,
    public status?: number,
    opts: { retryAfterSeconds?: number | null; contextOverflow?: boolean } = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.contextOverflow = opts.contextOverflow ?? false;
  }
}
