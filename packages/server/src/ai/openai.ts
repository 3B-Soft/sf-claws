import OpenAI from 'openai';
import type { AiProvider } from '@sf-claws/shared';
import type { LlmProvider, LlmRequest, LlmResponse, LlmBlock, LlmMessage } from './types.js';
import { LlmError, SYSTEM_CACHE_BOUNDARY } from './types.js';

/**
 * What one OpenAI-compatible endpoint does differently from OpenAI itself. Everything else — the
 * streaming shapes, tool calls, usage accounting, error mapping — is identical across these
 * gateways, so a dialect is all a new one needs.
 */
export interface OpenAiDialect {
  provider: AiProvider;
  /** Name used in error messages and the connection test. */
  label: string;
  /** Endpoint used when the credential carries no base URL of its own. */
  defaultBaseUrl?: string;
  /** Model the connection test falls back to when no enabled model is known. */
  defaultTestModel: string;
  /** Newer OpenAI models take `max_completion_tokens`; most compatible gateways only know `max_tokens`. */
  maxTokensParam: 'max_completion_tokens' | 'max_tokens';
  /**
   * How a thinking model is driven. `effort_param` sends `reasoning_effort` and gets no reasoning
   * text back; `reasoning_content` sends no knob (the model decides) and streams its reasoning in a
   * `reasoning_content` delta alongside the answer.
   */
  reasoning: 'effort_param' | 'reasoning_content';
}

export const OPENAI_DIALECT: OpenAiDialect = {
  provider: 'openai',
  label: 'OpenAI',
  defaultTestModel: 'gpt-5-mini',
  maxTokensParam: 'max_completion_tokens',
  reasoning: 'effort_param',
};

/**
 * Chat Completions transport shared by OpenAI and every OpenAI-compatible gateway (DeepSeek and
 * anything else reachable through a base URL).
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly provider: AiProvider;
  private client: OpenAI;
  private dialect: OpenAiDialect;
  constructor(apiKey: string, baseUrl: string | null | undefined, dialect: OpenAiDialect) {
    this.dialect = dialect;
    this.provider = dialect.provider;
    this.client = new OpenAI({ apiKey, baseURL: baseUrl || dialect.defaultBaseUrl || undefined, maxRetries: 3, timeout: 15 * 60_000 });
  }

  async test(modelId?: string): Promise<{ ok: boolean; message: string }> {
    try {
      const model = modelId || this.dialect.defaultTestModel;
      const r = await this.client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Reply with OK' }],
        [this.dialect.maxTokensParam]: 16,
      } as any);
      return { ok: true, message: `${this.dialect.label} reachable (model ${r.model})` };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // These endpoints cache implicitly on the prefix, so the boundary marker has nothing to do here
    // but take up room in the prompt.
    const system = req.system.replace(SYSTEM_CACHE_BOUNDARY, '').trim();
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }, ...req.messages.flatMap(toOpenAiMessages)];
    const tools: OpenAI.Chat.ChatCompletionTool[] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const useEffort = req.model.supportsThinking && this.dialect.reasoning === 'effort_param';
    const params: any = {
      model: req.model.modelId,
      messages,
      tools: tools.length ? tools : undefined,
      [this.dialect.maxTokensParam]: Math.min(req.maxTokens ?? 16000, req.model.maxOutputTokens || 16000),
      stream: true,
      stream_options: { include_usage: true },
      ...(useEffort ? { reasoning_effort: req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort } : {}),
      // Sampling dials go out only when an admin set one. A reasoning model is left alone entirely:
      // the OpenAI reasoning family rejects anything but the default temperature.
      ...(req.model.supportsThinking ? {} : sampling(req.model)),
    };
    try {
      const stream = (await this.client.chat.completions.create(params, { signal: req.signal })) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      let text = '';
      let thinking = '';
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let announced = 0;
      let finish: string | null = null;
      let usage: any = null;
      let refusal = '';
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d: any = choice.delta ?? {};
        if (d.content) {
          text += d.content;
          req.onText?.(d.content);
        }
        // Reasoning dialects interleave the model's thinking with the answer on the same delta.
        if (d.reasoning_content) {
          thinking += d.reasoning_content;
          req.onThinking?.(d.reasoning_content);
        }
        if (d.refusal) refusal += d.refusal;
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            const cur = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolCalls.set(tc.index, cur);
            // Chat completions has no per-block stop event: a call is complete once a later index
            // starts. The final call is therefore never announced early — by then the stream is
            // over and the caller has the whole message anyway.
            if (tc.index > announced) {
              for (let i = announced; i < tc.index; i++) {
                const done = toolCalls.get(i);
                if (done?.name) req.onToolCall?.({ id: done.id, name: done.name, input: parseArgs(done.args) });
              }
              announced = tc.index;
            }
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const content: LlmBlock[] = [];
      if (thinking) content.push({ type: 'thinking', text: thinking });
      if (text) content.push({ type: 'text', text });
      for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        content.push({ type: 'tool_use', id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.name, input: parseArgs(tc.args) });
      }
      const stopReason = refusal ? 'refusal' : toolCalls.size ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'stop' ? 'end_turn' : 'other';
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
      return {
        content,
        stopReason,
        refusalReason: refusal || null,
        usage: { inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached), outputTokens: usage?.completion_tokens ?? 0, cachedInputTokens: cached },
      };
    } catch (e) {
      throw toLlmError(e, this.dialect);
    }
  }
}

/** OpenAI itself (and any gateway pointed at through baseUrl). */
export class OpenAiProvider extends OpenAiCompatibleProvider {
  constructor(apiKey: string, baseUrl?: string | null) {
    super(apiKey, baseUrl, OPENAI_DIALECT);
  }
}

/** The admin's sampling dials, omitted entirely when unset so the provider default applies. */
function sampling(model: { temperature?: number | null; topP?: number | null }): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof model.temperature === 'number') out.temperature = model.temperature;
  if (typeof model.topP === 'number') out.top_p = model.topP;
  return out;
}

/** Tool arguments arrive as a JSON string. A malformed one is handed on rather than thrown away, so the model can see what it produced. */
function parseArgs(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _unparsed: args };
  }
}

function toOpenAiMessages(m: LlmMessage): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (m.role === 'assistant') {
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    const calls = m.content.filter((b) => b.type === 'tool_use') as Extract<LlmBlock, { type: 'tool_use' }>[];
    const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: 'assistant', content: text || null };
    if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
    return [msg];
  }
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const texts: string[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.isError ? `ERROR: ${b.content}` : b.content });
    else if (b.type === 'text') texts.push(b.text);
  }
  if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  return out;
}

function describeError(e: unknown): string {
  if (e instanceof OpenAI.APIError) return `${e.status ?? ''} ${e.name}: ${e.message}`.trim();
  return (e as Error)?.message ?? String(e);
}
function retryAfterOf(e: unknown): number | null {
  const raw = (e as any)?.headers?.['retry-after'] ?? (e as any)?.headers?.get?.('retry-after');
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** Context-window rejections come back as 400s naming the limit; compaction fixes them, retrying does not. */
function isContextOverflow(message: string): boolean {
  return /maximum context length|context_length_exceeded|too many tokens|reduce the length/i.test(message);
}
function toLlmError(e: unknown, d: OpenAiDialect): LlmError {
  const { provider, label } = d;
  if (e instanceof OpenAI.RateLimitError)
    return new LlmError(`${label} rate limited: ${e.message}`, provider, true, e.status, { retryAfterSeconds: retryAfterOf(e) });
  if (e instanceof OpenAI.AuthenticationError) return new LlmError(`${label} API key is invalid`, provider, false, e.status);
  if (e instanceof OpenAI.BadRequestError) {
    if (isContextOverflow(e.message))
      return new LlmError(`Conversation exceeds the model context window: ${e.message}`, provider, false, e.status, { contextOverflow: true });
    return new LlmError(`${label} rejected the request: ${e.message}`, provider, false, e.status);
  }
  if (e instanceof OpenAI.APIConnectionError) return new LlmError(`Cannot reach ${label}: ${e.message}`, provider, true);
  if (e instanceof OpenAI.APIError)
    return new LlmError(`${label} error ${e.status}: ${e.message}`, provider, (e.status ?? 500) >= 500, e.status, { retryAfterSeconds: retryAfterOf(e) });
  if ((e as any)?.name === 'AbortError') return new LlmError('Cancelled', provider, false);
  return new LlmError(describeError(e), provider, false);
}
