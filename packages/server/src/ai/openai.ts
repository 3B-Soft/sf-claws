import OpenAI from 'openai';
import type { AiProvider } from '@sf-claws/shared';
import type { LlmProvider, LlmRequest, LlmResponse, LlmBlock, LlmMessage } from './types.js';
import { LlmError, SYSTEM_CACHE_BOUNDARY } from './types.js';

/**
 * What one OpenAI-compatible endpoint does differently from another. Everything else — the
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
}

export const OPENAI_DIALECT: OpenAiDialect = {
  provider: 'openai',
  label: 'OpenAI',
  defaultTestModel: 'gpt-5-mini',
};

/**
 * Chat Completions transport shared by every OpenAI-compatible gateway (DeepSeek, DeepInfra and
 * anything else reachable through a base URL). They take `max_tokens`, get no effort knob, and
 * stream any thinking back as `reasoning_content`. OpenAI itself is on the Responses API below.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly provider: AiProvider;
  protected client: OpenAI;
  protected dialect: OpenAiDialect;
  constructor(apiKey: string, baseUrl: string | null | undefined, dialect: OpenAiDialect) {
    this.dialect = dialect;
    this.provider = dialect.provider;
    this.client = new OpenAI({ apiKey, baseURL: baseUrl || dialect.defaultBaseUrl || undefined, maxRetries: 3, timeout: 15 * 60_000 });
  }

  async test(modelId?: string): Promise<{ ok: boolean; message: string }> {
    try {
      const model = modelId || this.dialect.defaultTestModel;
      const r = await this.client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with OK' }], max_tokens: 16 });
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
    const params: any = {
      model: req.model.modelId,
      messages,
      tools: tools.length ? tools : undefined,
      max_tokens: Math.min(req.maxTokens ?? 16000, req.model.maxOutputTokens || 16000),
      stream: true,
      stream_options: { include_usage: true },
      // Sampling dials go out only when an admin set one. A reasoning model is left alone entirely:
      // the reasoning families reject anything but the default temperature.
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

/**
 * OpenAI itself (and any gateway pointed at through baseUrl), on the Responses API. Chat Completions
 * refuses function tools beside a reasoning effort on newer models, and agents always send tools.
 */
export class OpenAiProvider extends OpenAiCompatibleProvider {
  constructor(apiKey: string, baseUrl?: string | null) {
    super(apiKey, baseUrl, OPENAI_DIALECT);
  }

  override async test(modelId?: string): Promise<{ ok: boolean; message: string }> {
    try {
      // 16 is the smallest max_output_tokens the Responses API accepts.
      const model = modelId || this.dialect.defaultTestModel;
      const r = await this.client.responses.create({ model, input: 'Reply with OK', max_output_tokens: 16, store: false });
      return { ok: true, message: `${this.dialect.label} reachable (model ${r.model})` };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  override async complete(req: LlmRequest): Promise<LlmResponse> {
    const thinks = req.model.supportsThinking;
    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: req.model.modelId,
      // OpenAI caches implicitly on the prefix, so the boundary marker is only noise here.
      instructions: req.system.replace(SYSTEM_CACHE_BOUNDARY, '').trim(),
      input: req.messages.flatMap((m) => toResponsesInput(m, req.model.modelId)),
      tools: req.tools.length
        ? req.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.inputSchema, strict: false }))
        : undefined,
      max_output_tokens: Math.min(req.maxTokens ?? 16000, req.model.maxOutputTokens || 16000),
      stream: true,
      // Nothing is kept server side, so a reasoning model gets its encrypted reasoning back to replay.
      store: false,
      ...(thinks ? { reasoning: { effort: req.effort, summary: 'auto' as const }, include: ['reasoning.encrypted_content' as const] } : sampling(req.model)),
    };
    try {
      const stream = await this.client.responses.create(params, { signal: req.signal });
      let text = '';
      let thinking = '';
      let refusal = '';
      const calls: Extract<LlmBlock, { type: 'tool_use' }>[] = [];
      const reasoning: OpenAI.Responses.ResponseReasoningItem[] = [];
      let final: OpenAI.Responses.Response | null = null;
      for await (const ev of stream) {
        if (ev.type === 'response.output_text.delta') {
          text += ev.delta;
          req.onText?.(ev.delta);
        } else if (ev.type === 'response.reasoning_summary_text.delta') {
          thinking += ev.delta;
          req.onThinking?.(ev.delta);
        } else if (ev.type === 'response.reasoning_summary_part.added' && thinking) {
          thinking += '\n\n';
          req.onThinking?.('\n\n');
        } else if (ev.type === 'response.refusal.delta') refusal += ev.delta;
        else if (ev.type === 'response.output_item.done') {
          // Every item has its own done event, so a call is announced the moment its arguments close.
          if (ev.item.type === 'function_call') {
            const call = { id: ev.item.call_id, name: ev.item.name, input: parseArgs(ev.item.arguments) };
            calls.push({ type: 'tool_use', ...call });
            req.onToolCall?.(call);
          } else if (ev.item.type === 'reasoning') reasoning.push(ev.item);
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response;
        // `error` events are thrown by the SDK itself; a failed response arrives as an ordinary event.
        else if (ev.type === 'response.failed') throw new OpenAI.APIError(undefined, ev.response.error ?? { message: 'response failed' }, undefined, undefined);
      }
      const content: LlmBlock[] = [];
      if (thinking) content.push({ type: 'thinking', text: thinking });
      if (text) content.push({ type: 'text', text });
      content.push(...calls);
      const stopReason = refusal
        ? 'refusal'
        : calls.length
          ? 'tool_use'
          : final?.incomplete_details?.reason === 'max_output_tokens'
            ? 'max_tokens'
            : final?.status === 'completed'
              ? 'end_turn'
              : 'other';
      const usage = final?.usage;
      const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
      return {
        content,
        // Encrypted reasoning is bound to the model that produced it; the runtime tags it and hands it back.
        raw: reasoning.length ? reasoning : undefined,
        stopReason,
        refusalReason: refusal || null,
        usage: { inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - cached), outputTokens: usage?.output_tokens ?? 0, cachedInputTokens: cached },
      };
    } catch (e) {
      throw toLlmError(e, this.dialect);
    }
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
    // Compatible endpoints cannot replay our provider-neutral `thinking` blocks. If thinking is
    // all this turn contains, omitting the turn is the only valid representation: sending an
    // assistant message with both `content: null` and no tool_calls is rejected by DeepSeek.
    // This occurs when a reasoning model reaches its output limit before emitting visible text;
    // the following user continuation message still tells it how to proceed.
    if (!text && !calls.length) return [];
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

/** One message as Responses input items. Reasoning this same model produced goes back first, ahead of the answer it led to. */
function toResponsesInput(m: LlmMessage, modelId: string): OpenAI.Responses.ResponseInputItem[] {
  if (m.role === 'assistant') {
    const raw = m.raw?.provider === 'openai' && m.raw.modelId === modelId && Array.isArray(m.raw.content) ? m.raw.content : [];
    const out: OpenAI.Responses.ResponseInputItem[] = [...(raw as OpenAI.Responses.ResponseReasoningItem[])];
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    if (text) out.push({ role: 'assistant', content: text });
    for (const b of m.content) {
      if (b.type === 'tool_use') out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    }
    return out;
  }
  const out: OpenAI.Responses.ResponseInputItem[] = [];
  const texts: string[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result') out.push({ type: 'function_call_output', call_id: b.toolUseId, output: b.isError ? `ERROR: ${b.content}` : b.content });
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
  return /maximum context length|context_length_exceeded|context window|too many tokens|reduce the length/i.test(message);
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
