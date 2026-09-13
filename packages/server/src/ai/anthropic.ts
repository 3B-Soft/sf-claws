import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmRequest, LlmResponse, LlmBlock, LlmMessage } from './types.js';
import { LlmError, splitSystemPrompt } from './types.js';

export class AnthropicProvider implements LlmProvider {
  readonly provider = 'anthropic' as const;
  private client: Anthropic;
  constructor(apiKey: string, baseUrl?: string | null) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl || undefined, maxRetries: 3, timeout: 15 * 60_000 });
  }

  async test(modelId = 'claude-haiku-4-5'): Promise<{ ok: boolean; message: string }> {
    try {
      const r = await this.client.messages.create({ model: modelId, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK' }] });
      return { ok: true, message: `Anthropic reachable (model ${r.model})` };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const messages: Anthropic.MessageParam[] = req.messages.map((m) => toAnthropicMessage(m, req.model.modelId));
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));
    // Prompt caching. The cache matches on an exact prefix, so we mark the end of each stable
    // region: the tool schemas (fixed for a role), the system prompt, and a rolling breakpoint just
    // behind the live end of the conversation. Without the last one every iteration of a 20-40 step
    // builder loop re-bills the whole transcript at full price.
    if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } } as Anthropic.Tool;
    markRollingCachePoint(messages);
    const params: Anthropic.MessageStreamParams = {
      model: req.model.modelId,
      max_tokens: Math.min(req.maxTokens ?? 16000, req.model.maxOutputTokens || 16000),
      system: anthropicSystemBlocks(req.system),
      messages,
      tools: tools.length ? tools : undefined,
      ...(req.model.supportsThinking
        ? { thinking: { type: 'adaptive', display: 'summarized' } as any, output_config: { effort: req.effort } as any }
        : // Anthropic refuses temperature and top_p alongside extended thinking, so the dials apply
          // only to a non-thinking model, and only when the super admin actually set one.
          {
            ...(typeof req.model.temperature === 'number' ? { temperature: req.model.temperature } : {}),
            ...(typeof req.model.topP === 'number' ? { top_p: req.model.topP } : {}),
          }),
    };
    try {
      const stream = this.client.messages.stream(params, { signal: req.signal });
      stream.on('text', (d) => req.onText?.(d));
      // content_block_stop: the block is complete and its input is parsed. This is what lets the
      // agent start a read while the model is still writing the rest of the message.
      stream.on('contentBlock', (b) => {
        if (b.type === 'tool_use') req.onToolCall?.({ id: b.id, name: b.name, input: b.input });
      });
      stream.on('streamEvent', (ev: any) => {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && ev.delta.thinking) req.onThinking?.(ev.delta.thinking);
      });
      const msg = await stream.finalMessage();
      const content: LlmBlock[] = [];
      for (const b of msg.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        else if (b.type === 'thinking' && b.thinking) content.push({ type: 'thinking', text: b.thinking });
      }
      const stopReason =
        msg.stop_reason === 'tool_use'
          ? 'tool_use'
          : msg.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : msg.stop_reason === 'refusal'
              ? 'refusal'
              : msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence'
                ? 'end_turn'
                : 'other';
      const u: any = msg.usage;
      return {
        content,
        raw: msg.content,
        stopReason,
        refusalReason: msg.stop_reason === 'refusal' ? ((msg as any).stop_details?.explanation ?? 'The model declined this request') : null,
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          cachedInputTokens: u.cache_read_input_tokens ?? 0,
        },
      };
    } catch (e) {
      throw toLlmError(e);
    }
  }
}

/**
 * The system prompt as Anthropic content blocks: the stable half carries the cache breakpoint, the
 * dynamic half (page context, plan state, memory index) follows uncached. One block with a single
 * breakpoint would be re-billed in full every time the user navigated to another record.
 */
export function anthropicSystemBlocks(system: string): Anthropic.TextBlockParam[] {
  const { stable, dynamic } = splitSystemPrompt(system);
  const blocks: Anthropic.TextBlockParam[] = [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }];
  if (dynamic) blocks.push({ type: 'text', text: dynamic });
  return blocks;
}

/**
 * Put a cache breakpoint on the last content block of the second-to-last message. Everything up to
 * it is stable across the next call, so the next iteration reads it from cache instead of paying
 * for it again. The final message is left uncached because it changes every turn.
 */
function markRollingCachePoint(messages: Anthropic.MessageParam[]): void {
  if (messages.length < 3) return;
  const target = messages[messages.length - 2];
  if (!Array.isArray(target.content) || !target.content.length) return;
  const blocks = [...target.content];
  const last = blocks[blocks.length - 1] as Anthropic.ContentBlockParam;
  // Thinking blocks carry model-bound signatures and must be replayed byte-for-byte; do not touch.
  if (last.type === 'thinking' || last.type === 'redacted_thinking') return;
  blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam;
  target.content = blocks;
}

function toAnthropicMessage(m: LlmMessage, modelId: string): Anthropic.MessageParam {
  if (m.role === 'assistant' && m.raw && m.raw.provider === 'anthropic' && m.raw.modelId === modelId && Array.isArray(m.raw.content)) {
    return { role: 'assistant', content: m.raw.content as Anthropic.ContentBlockParam[] };
  }
  const content: Anthropic.ContentBlockParam[] = [];
  for (const b of m.content) {
    if (b.type === 'text') {
      if (b.text.trim()) content.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    else if (b.type === 'tool_result') content.push({ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError });
    // thinking blocks from other providers/models are dropped
  }
  if (!content.length) content.push({ type: 'text', text: '(empty)' });
  return { role: m.role, content };
}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `${e.status ?? ''} ${e.name}: ${e.message}`.trim();
  return (e as Error)?.message ?? String(e);
}
function retryAfterOf(e: unknown): number | null {
  const raw = (e as any)?.headers?.['retry-after'] ?? (e as any)?.headers?.get?.('retry-after');
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** A context-window rejection is a 400 whose message names the limit; compaction fixes it, retrying does not. */
function isContextOverflow(message: string): boolean {
  return /prompt is too long|context window|maximum context length|too many tokens/i.test(message);
}
function toLlmError(e: unknown): LlmError {
  if (e instanceof Anthropic.RateLimitError)
    return new LlmError(`Anthropic rate limited: ${e.message}`, 'anthropic', true, e.status, { retryAfterSeconds: retryAfterOf(e) });
  if (e instanceof Anthropic.AuthenticationError) return new LlmError('Anthropic API key is invalid', 'anthropic', false, e.status);
  if (e instanceof Anthropic.BadRequestError) {
    if (isContextOverflow(e.message))
      return new LlmError(`Conversation exceeds the model context window: ${e.message}`, 'anthropic', false, e.status, { contextOverflow: true });
    return new LlmError(`Anthropic rejected the request: ${e.message}`, 'anthropic', false, e.status);
  }
  if (e instanceof Anthropic.APIConnectionError) return new LlmError(`Cannot reach Anthropic: ${e.message}`, 'anthropic', true);
  if (e instanceof Anthropic.APIError)
    return new LlmError(`Anthropic error ${e.status}: ${e.message}`, 'anthropic', (e.status ?? 500) >= 500, e.status, { retryAfterSeconds: retryAfterOf(e) });
  if ((e as any)?.name === 'AbortError') return new LlmError('Cancelled', 'anthropic', false);
  return new LlmError(describeError(e), 'anthropic', false);
}
