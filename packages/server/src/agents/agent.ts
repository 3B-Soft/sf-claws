import type { AgentRole, AiModel } from '@sf-claws/shared';
import type { LlmMessage, LlmBlock, LlmProvider, LlmResponse, LlmTool, Effort } from '../ai/types.js';
import { LlmError } from '../ai/types.js';
import type { ToolContext, ToolDef } from './tools.js';
import { toLlmTools, isConcurrencySafe, resultLimitFor } from './tools.js';
import { toolLabel, COMPACTION_SYSTEM_PROMPT, COMPACTION_RESUME_LINE, stripAnalysis } from './prompts.js';
import { newId } from '../lib/crypto.js';
import { runScheduled } from './scheduler.js';
import { coerceArgs, validateArgs } from './coerce.js';
import { repairOrphanedToolUses, syntheticToolResults, toStoredMessages } from './conversation.js';
import { backoffMs, shouldRetry, MAX_PROVIDER_ATTEMPTS } from './backoff.js';
import { CostCeilingError, projectCallCostUsd } from './cost.js';
import { budgetTurnResults } from './budget.js';
import { formatReminders } from './reminders.js';
import { describeCacheBreak, type PromptSection } from './cache-probe.js';

export interface AgentConfig {
  agentId: string;
  parentId: string | null;
  role: AgentRole;
  model: AiModel;
  provider: LlmProvider;
  effort: Effort;
  maxIterations: number;
  system: string;
  /** The system prompt as named sections, for cache-break detection. Optional: defaults to one section. */
  promptSections?: PromptSection[];
  tools: ToolDef[];
  /** Persist conversation between turns (orchestrator). Sub-agents are ephemeral. */
  persistent: boolean;
  /** Fallback model used when the primary is unavailable (overload / rate limit exhaustion). */
  fallback?: { model: AiModel; provider: LlmProvider } | null;
  /** A client's "## Compact instructions" block, honoured by the summariser. */
  compactInstructions?: string | null;
}

/**
 * Why an agent stopped. Every exit is named: an operator reading the panel should never have to
 * guess whether an agent finished, gave up, ran out of budget or was interrupted.
 */
export type StopReason =
  | 'end_turn' // the model produced a final answer
  | 'max_iterations' // hit the per-role iteration cap
  | 'refusal' // the model declined
  | 'provider_error' // unrecoverable provider failure after retries
  | 'cancelled' // user cancelled / abort signal
  | 'cost_ceiling' // a spend ceiling would be crossed
  | 'stuck_loop' // the same failing action repeated with no progress
  | 'context_exhausted' // compaction could not make the conversation fit
  | 'awaiting_user'; // paused for a structured question / plan approval

export interface AgentOutcome {
  text: string;
  ok: boolean;
  iterations: number;
  stoppedBy: StopReason;
}

/** How many identical consecutive tool calls (same name + args) before we call it a loop. */
const STUCK_REPEAT_LIMIT = 3;
/** How many identical consecutive validation failure sets before the loop is declared stuck. */
const STUCK_VALIDATION_LIMIT = 3;
/** Output slot reserved by default; escalated once on truncation (p99 real output is far below 8k). */
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const ESCALATED_MAX_OUTPUT_TOKENS = 64000;
/** Total spilled tool output kept per session before overflow stops being persisted. */
const MAX_SESSION_ARTIFACT_BYTES = 32 * 1024 * 1024;
/** Bound on max-token continuations, so a chatty model cannot spin the loop. */
const MAX_OUTPUT_RECOVERIES = 3;
/** Output slot reserved for the compaction summary. */
const COMPACTION_OUTPUT_TOKENS = 8000;
/** Messages kept verbatim behind the compaction boundary. */
const COMPACTION_KEEP_TAIL = 6;

/** Sent after an output-limit truncation: resume, do not resend. */
export const OUTPUT_CONTINUATION_TEXT =
  'Output token limit hit. Resume directly from where the previous message stopped: no apology, no recap. Break the remaining work into smaller pieces (several tool calls or shorter messages) rather than one long reply.';

/**
 * One agent = one model + one system prompt + one tool set running a manual agentic loop.
 * Provider neutral (Anthropic / OpenAI) via LlmProvider.
 */
export class AgentRun {
  private messages: LlmMessage[] = [];
  /** Fingerprints of recent tool calls, for stuck-loop detection. */
  private recentCallSignatures: string[] = [];
  /** Fingerprints of recent validation failure sets: write → validate → write → validate with cosmetic edits never repeats a call, but it does repeat the failures. */
  private recentValidationFailures: string[] = [];
  private outputRecoveries = 0;
  /**
   * Signatures of pure reads already answered in this run. Re-reading the same component in a
   * validate-fix-validate loop is common and expensive; a stub costs a few tokens instead of a few
   * thousand. Cleared whenever anything mutates (the earlier answer may be stale), whenever the
   * conversation is rewritten (compaction, eviction — the earlier answer is gone) and on a
   * provider retry (an early-started read may have been memoised for a message that was thrown
   * away).
   */
  private readMemo = new Set<string>();
  private escalatedOutputSlot = false;
  private reactiveCompactionUsed = false;
  /**
   * Tool calls started while the message was still streaming, keyed by tool_use id. See
   * `startEarly` for the eligibility rule; `execBatch` collects these instead of re-running them.
   */
  private earlyStarts = new Map<string, Promise<LlmBlock>>();
  /** Set once a block in the current message is not eligible: nothing after it may start early. */
  private earlyStartWindowClosed = false;

  constructor(
    private cfg: AgentConfig,
    private ctx: ToolContext,
  ) {
    if (cfg.persistent) {
      const stored = ctx.app.repos.messages.list(ctx.session.id, cfg.agentId).map((m) => m.content as LlmMessage);
      // A crash between persisting the assistant message and its tool results leaves dangling
      // tool_use blocks that both providers reject on replay. Repair before we ever send them.
      const repaired = repairOrphanedToolUses(stored);
      if (repaired !== stored) {
        ctx.app.log.warn({ sessionId: ctx.session.id, agentId: cfg.agentId }, 'repaired orphaned tool_use blocks from a previous run');
        ctx.app.repos.messages.replace(ctx.session.id, cfg.agentId, toStoredMessages(repaired));
      }
      this.messages = repaired;
    }
  }

  async run(userText: string): Promise<AgentOutcome> {
    const { cfg, ctx } = this;
    const bus = ctx.runtime.bus;
    const sessionId = ctx.session.id;
    this.push({ role: 'user', content: [{ type: 'text', text: userText }] });
    let iterations = 0;
    let lastText = '';
    const llmTools = toLlmTools(cfg.tools);

    while (iterations < cfg.maxIterations) {
      if (ctx.signal.aborted) return this.finish(lastText, false, iterations, 'cancelled');
      iterations++;

      // Ceilings are checked before the call, with what the call is about to cost: enforcing
      // after the fact only reports money gone, and a 1M-token call passing at $0 spent would
      // overshoot a small turn ceiling by its whole price.
      const ceiling = this.checkCeiling(this.projectedCost(cfg.model, llmTools));
      if (ceiling) return this.finish(lastText || ceiling.message, false, iterations, 'cost_ceiling');

      try {
        await this.maybeCompact();
      } catch (e) {
        if (e instanceof CostCeilingError) return this.finish(lastText || e.message, false, iterations, 'cost_ceiling');
        ctx.app.log.warn({ err: (e as Error).message }, 'proactive compaction failed; continuing uncompacted');
      }
      const messageId = newId('am');
      const started = Date.now();
      let streamed = '';
      let resp: LlmResponse;
      let answeredBy: AiModel;
      // Discard anything left over from a previous iteration: ids are unique per message, so a
      // stale entry could never be matched, but keeping the map small keeps the invariant obvious.
      this.earlyStarts.clear();
      this.earlyStartWindowClosed = false;
      try {
        ({ resp, model: answeredBy } = await this.complete(llmTools, messageId, (d) => {
          streamed += d;
        }));
      } catch (e) {
        if (ctx.signal.aborted) return this.finish(lastText, false, iterations, 'cancelled');
        if (e instanceof CostCeilingError) {
          bus.emit(sessionId, { type: 'session.limit', scope: e.scope, limitUsd: e.limitUsd, spentUsd: e.spentUsd, message: e.message });
          return this.finish(lastText || e.message, false, iterations, 'cost_ceiling');
        }
        const err = e as LlmError;
        // A context-length rejection is recoverable exactly once: compact hard, then retry.
        if (err instanceof LlmError && err.contextOverflow && !this.reactiveCompactionUsed) {
          this.reactiveCompactionUsed = true;
          bus.emit(sessionId, {
            type: 'session.error',
            agentId: cfg.agentId,
            message: 'Conversation grew past the model context window — compacting and retrying.',
            recoverable: true,
          });
          let compacted = false;
          try {
            compacted = await this.compactNow(0.35);
          } catch (ce) {
            if (ce instanceof CostCeilingError) return this.finish(lastText || ce.message, false, iterations, 'cost_ceiling');
          }
          if (compacted) continue;
          return this.finish(lastText || 'The conversation no longer fits in the model context window.', false, iterations, 'context_exhausted');
        }
        bus.emit(sessionId, { type: 'session.error', agentId: cfg.agentId, message: (e as Error).message, recoverable: false });
        return this.finish(lastText || `The model provider failed: ${(e as Error).message}`, false, iterations, 'provider_error');
      }

      this.recordUsage(answeredBy, resp.usage, started);
      this.probeCache(llmTools, resp);

      const text = resp.content
        .filter((b): b is Extract<LlmBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) {
        lastText = text;
        bus.emit(sessionId, { type: 'assistant.message', agentId: cfg.agentId, role: cfg.role, messageId, text });
      } else if (streamed.trim()) {
        lastText = streamed.trim();
      }
      // Raw content (thinking signatures) is bound to the model that produced it, so it is tagged
      // with the model that actually answered — after a fallback that is not `cfg.model`.
      this.push({
        role: 'assistant',
        content: resp.content,
        raw: resp.raw ? { provider: answeredBy.provider, modelId: answeredBy.modelId, content: resp.raw } : undefined,
      });

      if (resp.stopReason === 'refusal') {
        bus.emit(sessionId, {
          type: 'session.error',
          agentId: cfg.agentId,
          message: `The model declined: ${resp.refusalReason ?? 'no reason given'}`,
          recoverable: true,
        });
        return this.finish(lastText || `The model declined this request (${resp.refusalReason ?? 'safety'}).`, false, iterations, 'refusal');
      }

      const calls = resp.content.filter((b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!calls.length) {
        if (resp.stopReason === 'max_tokens' && this.outputRecoveries < MAX_OUTPUT_RECOVERIES) {
          // Widen the slot and tell the model to resume. Continuing silently would replay the
          // truncated message as a prefill; asking it to "be more concise" throws work away.
          this.outputRecoveries++;
          this.escalatedOutputSlot = true;
          this.push({ role: 'user', content: [{ type: 'text', text: OUTPUT_CONTINUATION_TEXT }] });
          continue;
        }
        return this.finish(lastText, true, iterations, 'end_turn');
      }

      if (this.isStuck(calls)) {
        const msg = `Stopped: the same action was repeated ${STUCK_REPEAT_LIMIT} times with no progress. Report what is blocking rather than retrying.`;
        bus.emit(sessionId, { type: 'session.error', agentId: cfg.agentId, message: msg, recoverable: true });
        return this.finish(lastText || msg, false, iterations, 'stuck_loop');
      }

      const results = await this.execBatch(calls);
      this.push({ role: 'user', content: results });
      if (ctx.signal.aborted) return this.finish(lastText, false, iterations, 'cancelled');
      if (this.validationStuck()) {
        const msg = `Stopped: validation failed with the same errors ${STUCK_VALIDATION_LIMIT} times in a row. The edits between attempts did not address them; report what is blocking.`;
        bus.emit(sessionId, { type: 'session.error', agentId: cfg.agentId, message: msg, recoverable: true });
        return this.finish(lastText || msg, false, iterations, 'stuck_loop');
      }
      // A tool may have paused the run for the user (plan approval, structured question).
      if (ctx.runtime.isAwaitingUser(sessionId)) return this.finish(lastText, true, iterations, 'awaiting_user');
      // A researcher that has spent its read budget cannot make progress; make it report now.
      const budget = ctx.research?.readBudget;
      if (budget && budget.used >= budget.max && !cfg.persistent) {
        const report = await this.wrapUp(`Your file-read budget (${budget.max} files) is spent`);
        return this.finish(report || lastText, true, iterations, 'end_turn');
      }
    }
    bus.emit(sessionId, {
      type: 'session.error',
      agentId: cfg.agentId,
      message: `Agent ${cfg.role} reached its iteration limit (${cfg.maxIterations}).`,
      recoverable: true,
    });
    // A sub-agent that hits its cap still owes the lead agent a report; one tool-less call turns
    // the junk of a half-finished loop into a usable hand-over.
    const report = cfg.persistent ? '' : await this.wrapUp(`You have reached your step limit (${cfg.maxIterations} iterations)`);
    return this.finish(report || lastText || 'Stopped: iteration limit reached.', false, iterations, 'max_iterations');
  }

  private finish(text: string, ok: boolean, iterations: number, stoppedBy: StopReason): AgentOutcome {
    return { text, ok, iterations, stoppedBy };
  }

  /**
   * Forced wrap-up: one completion with no tools, asking for the report. Failures degrade to an
   * empty string so the caller can fall back to whatever text the loop produced.
   */
  private async wrapUp(reason: string): Promise<string> {
    const { cfg, ctx } = this;
    if (ctx.signal.aborted) return '';
    this.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[Harness] ${reason}. Stop searching and stop calling tools now. Write your final report from what you have already found, in the report sections your role defines, and say explicitly what you did not get to. Tools are no longer available for this message.`,
        },
      ],
    });
    if (this.checkCeiling(this.projectedCost(cfg.model, []))) return '';
    try {
      const started = Date.now();
      const { resp, model } = await this.complete([], newId('am'), () => {});
      this.recordUsage(model, resp.usage, started);
      const text = resp.content
        .filter((b): b is Extract<LlmBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      this.push({ role: 'assistant', content: resp.content });
      if (text) ctx.runtime.bus.emit(ctx.session.id, { type: 'assistant.message', agentId: cfg.agentId, role: cfg.role, messageId: newId('am'), text });
      return text;
    } catch (e) {
      ctx.app.log.warn({ agentId: cfg.agentId, err: (e as Error).message }, 'forced wrap-up failed');
      return '';
    }
  }

  /** One completion with bounded retry, jittered backoff and a single fallback-model attempt. */
  private async complete(llmTools: LlmTool[], messageId: string, onDelta: (d: string) => void): Promise<{ resp: LlmResponse; model: AiModel }> {
    const { cfg, ctx } = this;
    const bus = ctx.runtime.bus;
    let usingFallback = false;
    for (let attempt = 1; ; attempt++) {
      const model = usingFallback && cfg.fallback ? cfg.fallback.model : cfg.model;
      const provider = usingFallback && cfg.fallback ? cfg.fallback.provider : cfg.provider;
      try {
        const resp = await provider.complete({
          model,
          system: cfg.system,
          // Thinking signatures are bound to the model that produced them; replaying them on a
          // different model is a hard 400, so strip them when we fall back.
          messages: usingFallback ? stripProviderRaw(this.messages) : this.messages,
          tools: llmTools,
          effort: cfg.effort,
          signal: ctx.signal,
          maxTokens: this.outputSlot(model),
          onText: (d) => {
            onDelta(d);
            bus.emit(ctx.session.id, { type: 'assistant.delta', agentId: cfg.agentId, role: cfg.role, messageId, delta: d });
          },
          onThinking: (d) => bus.emit(ctx.session.id, { type: 'assistant.thinking', agentId: cfg.agentId, role: cfg.role, text: d }),
          onToolCall: llmTools.length ? (call) => this.startEarly(call) : undefined,
        });
        return { resp, model };
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        // The message that failed may have started reads early and memoised them; the retry will
        // produce a different message, so those memo entries would answer calls that never landed.
        this.readMemo.clear();
        this.earlyStarts.clear();
        this.earlyStartWindowClosed = false;
        const err = e as LlmError;
        const retryable = err instanceof LlmError && err.retryable && !err.contextOverflow;
        if (!shouldRetry(attempt, retryable)) {
          // Out of retries on the primary: try the fallback model once before giving up.
          if (retryable && cfg.fallback && !usingFallback) {
            usingFallback = true;
            attempt = 0;
            bus.emit(ctx.session.id, {
              type: 'session.error',
              agentId: cfg.agentId,
              message: `Switching to fallback model ${cfg.fallback.model.label}.`,
              recoverable: true,
            });
            continue;
          }
          throw e;
        }
        const delay = backoffMs({ attempt, status: err.status, retryAfterSeconds: err.retryAfterSeconds });
        bus.emit(ctx.session.id, {
          type: 'session.error',
          agentId: cfg.agentId,
          message: `${err.message} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${MAX_PROVIDER_ATTEMPTS})`,
          recoverable: true,
        });
        await sleep(delay, ctx.signal);
      }
    }
  }

  /**
   * Output slot reservation. The API deducts `max_tokens` from usable context whether or not the
   * model uses it, and real replies are far shorter than the model's ceiling — so reserve a small
   * slot and widen it only after an actual truncation.
   */
  private outputSlot(model: AiModel): number {
    const wanted = this.escalatedOutputSlot ? ESCALATED_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS;
    return Math.min(wanted, model.maxOutputTokens || wanted);
  }

  /** What the next call is about to cost, at this model's list price, before it is made. */
  private projectedCost(model: AiModel, llmTools: LlmTool[]): number {
    const inputTokens = estimateTokens(this.messages) + Math.ceil((this.cfg.system.length + JSON.stringify(llmTools).length) / 4);
    return projectCallCostUsd(model, inputTokens, this.outputSlot(model));
  }

  /** The ceiling a call of `projectedUsd` would cross, emitted as a session.limit event, or null. */
  private checkCeiling(projectedUsd: number): CostCeilingError | null {
    const { cfg, ctx } = this;
    const ceiling = ctx.runtime.checkBudget(ctx.session.id, cfg.role, projectedUsd);
    if (ceiling) {
      ctx.runtime.bus.emit(ctx.session.id, {
        type: 'session.limit',
        scope: ceiling.scope,
        limitUsd: ceiling.limitUsd,
        spentUsd: ceiling.spentUsd,
        message: ceiling.message,
      });
    }
    return ceiling;
  }

  private recordUsage(model: AiModel, usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }, startedAt: number): void {
    const { cfg, ctx } = this;
    const cost = ctx.app.ai.cost(model, usage);
    ctx.app.repos.usage.add({
      sessionId: ctx.session.id,
      userId: ctx.session.userId,
      clientId: ctx.session.clientId,
      role: cfg.role,
      provider: model.provider,
      modelId: model.modelId,
      ...usage,
      costUsd: cost,
      durationMs: Date.now() - startedAt,
    });
    ctx.app.repos.sessions.addUsage(ctx.session.id, { ...usage, costUsd: cost });
    ctx.runtime.addTurnCost(ctx.session.id, cost);
    const s = ctx.app.repos.sessions.byId(ctx.session.id)!;
    ctx.runtime.bus.emit(ctx.session.id, {
      type: 'session.usage',
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cachedInputTokens: s.cachedInputTokens,
      costUsd: s.costUsd,
    });
  }

  /** Feed the cache-break probe; a drop in cached tokens names the prompt section that changed. */
  private probeCache(llmTools: LlmTool[], resp: LlmResponse): void {
    const { cfg, ctx } = this;
    const sections = cfg.promptSections ?? [{ name: 'system', text: cfg.system }];
    const brk = ctx.runtime.cacheProbe.observe(`${ctx.session.id}:${cfg.agentId}`, sections, llmTools, resp.usage);
    if (brk) ctx.app.log.warn({ sessionId: ctx.session.id, agentId: cfg.agentId, role: cfg.role }, describeCacheBreak(brk));
  }

  /**
   * Detect the model retrying the identical call. Salesforce validation loops are the common case:
   * the same broken metadata revalidated until the iteration budget is gone.
   */
  private isStuck(calls: Extract<LlmBlock, { type: 'tool_use' }>[]): boolean {
    const signature = calls.map((c) => `${c.name}:${stableStringify(c.input)}`).join('|');
    this.recentCallSignatures.push(signature);
    if (this.recentCallSignatures.length > STUCK_REPEAT_LIMIT) this.recentCallSignatures.shift();
    return this.recentCallSignatures.length === STUCK_REPEAT_LIMIT && this.recentCallSignatures.every((s) => s === signature);
  }

  /** Three consecutive validations failing with the same failure set: the edits in between changed nothing that mattered. */
  private validationStuck(): boolean {
    const r = this.recentValidationFailures;
    return r.length >= STUCK_VALIDATION_LIMIT && r.slice(-STUCK_VALIDATION_LIMIT).every((s) => s === r[r.length - 1]);
  }

  /**
   * Start a tool call the moment its block finishes streaming, instead of waiting for the rest of
   * the message. On a turn that opens with three searches this removes most of the model's writing
   * time from the wall clock.
   *
   * Three conditions, all necessary:
   *
   * - **The call is a concurrency-safe read.** Concurrency-safe alone is not enough: `run_subagent`
   *   qualifies for an analyst, and starting one speculatively would spend real money on a message
   *   that a mid-stream provider failure may yet throw away. A read costs a request that the
   *   scheduler was about to make anyway.
   * - **The tool has not opted out** (`earlyStart: false`). `investigate_product_repo` is a read
   *   from the org's point of view but it starts a paid researcher; the flag says so explicitly
   *   instead of lying about `readOnly`.
   * - **Every preceding tool call in this message was eligible too.** The scheduler runs an unsafe
   *   call alone, in emission order; starting a later call before it would break exactly the
   *   guarantee the scheduler exists to provide. So one ineligible block closes the window for the
   *   rest of the message.
   *
   * The prefix condition means early starts are always the leading run of safe reads — precisely
   * the first batch `runScheduled` would have executed in parallel anyway. Ordering, budgeting and
   * the results the model sees are unchanged; only the start time moves.
   */
  private startEarly(call: { id: string; name: string; input: unknown }): void {
    if (this.earlyStartWindowClosed || this.ctx.signal.aborted) return;
    const def = this.cfg.tools.find((t) => t.name === call.name);
    if (!def?.readOnly || def.earlyStart === false || !isConcurrencySafe(def, call.input, this.ctx)) {
      this.earlyStartWindowClosed = true;
      return;
    }
    // execTool resolves rather than rejects, but a speculative promise nobody awaits must never be
    // able to take the process down.
    const promise = this.execTool({ type: 'tool_use', ...call }).catch((e) => ({
      type: 'tool_result' as const,
      toolUseId: call.id,
      content: `Tool error: ${(e as Error).message}`,
      isError: true,
    }));
    this.earlyStarts.set(call.id, promise);
  }

  /**
   * Run a turn's tool calls with safety-aware scheduling, then apply the per-turn result budget so
   * a fan-out of large reads cannot swamp the context window in a single message.
   */
  private async execBatch(calls: Extract<LlmBlock, { type: 'tool_use' }>[]): Promise<LlmBlock[]> {
    const executed = await runScheduled(calls, {
      isSafe: (call) => {
        const def = this.cfg.tools.find((t) => t.name === call.name);
        return def ? isConcurrencySafe(def, call.input, this.ctx) : false;
      },
      limit: 6,
      shouldStop: () => this.ctx.signal.aborted,
      onSkipped: (call) => syntheticToolResults([call.id])[0],
      run: (call) => this.earlyStarts.get(call.id) ?? this.execTool(call),
    });
    return budgetTurnResults(
      executed.map((block, i) => ({ tool: calls[i].name, block })),
      {
        limitFor: (name) => resultLimitFor(this.cfg.tools.find((t) => t.name === name)),
        persist: (tool, content) => this.persistArtifact(tool, content),
      },
    );
  }

  /**
   * Persist an oversized output as an artifact. A long loop over large outputs would otherwise
   * grow the database without bound. Past the cap the result is still truncated for context, just
   * no longer retrievable — which is the right trade: protecting the database matters more than
   * paging back into the hundredth oversized log of a single session.
   */
  private persistArtifact(tool: string, content: string): string | null {
    if (this.ctx.app.repos.artifacts.bytesForSession(this.ctx.session.id) > MAX_SESSION_ARTIFACT_BYTES) return null;
    const artifact = this.ctx.app.repos.artifacts.create({ sessionId: this.ctx.session.id, tool, label: `${tool} output`, content });
    return artifact.id;
  }

  private async execTool(call: Extract<LlmBlock, { type: 'tool_use' }>): Promise<LlmBlock> {
    const { cfg, ctx } = this;
    const bus = ctx.runtime.bus;
    const def = cfg.tools.find((t) => t.name === call.name);
    // Models emit "150" and "false" often enough that untyped args silently corrupt limits/flags.
    const input = coerceArgs(call.input, def?.inputSchema);
    const label = toolLabel(call.name, input);
    bus.emit(ctx.session.id, { type: 'tool.call', agentId: cfg.agentId, role: cfg.role, toolCallId: call.id, tool: call.name, label, input: safeInput(input) });
    const started = Date.now();
    let text: string;
    let output: unknown;
    let ok = true;
    const planRefusal = def?.requiresApprovedPlan ? ctx.runtime.requireApprovedPlan(ctx.session.id, call.name, input) : null;
    const invalid = def ? validateArgs(input, def.inputSchema) : null;
    const memoKey = def && DEDUPABLE_READS.has(call.name) ? `${call.name}:${stableStringify(input)}` : null;
    if (!def) {
      text = `Unknown tool ${call.name}`;
      ok = false;
    } else if (invalid) {
      // Caught here rather than inside the tool: `describe_sobject({})` would otherwise reach
      // Salesforce as "undefined" and `todo_write({})` would throw on `.map`.
      text = `Invalid arguments for ${call.name}: ${invalid}`;
      ok = false;
    } else if (planRefusal) {
      text = planRefusal;
      ok = false;
    } else if (memoKey && this.readMemo.has(memoKey)) {
      text =
        'Unchanged since you ran this exact call earlier in this run — refer to that earlier result rather than re-reading it. If you believe the org has changed since, make a different call.';
    } else {
      // Anything that is not a pure read may have invalidated every earlier read.
      if (!def.readOnly) this.readMemo.clear();
      try {
        const pending = def.run(input, ctx);
        // A blocking tool (a deploy, a commit, a record write) must finish and have its result
        // recorded even when the user cancels mid-flight; the runtime waits for these.
        if (def.interruptBehavior === 'block') ctx.runtime.trackBlocking(ctx.session.id, pending);
        const r = await pending;
        text = r.text;
        output = r.output;
        ok = r.ok !== false;
        if (memoKey && ok) this.readMemo.add(memoKey);
      } catch (e) {
        ok = false;
        text = `Tool error: ${(e as Error).message}`;
        output = { error: (e as Error).message, details: (e as any).details };
        ctx.app.log.warn({ tool: call.name, err: (e as Error).message }, 'tool failed');
      }
      if (call.name === 'validate_deployment') {
        if (ok) this.recentValidationFailures = [];
        else this.recentValidationFailures.push(validationSignature(output));
      }
    }
    const durationMs = Date.now() - started;
    bus.emit(ctx.session.id, {
      type: 'tool.result',
      agentId: cfg.agentId,
      role: cfg.role,
      toolCallId: call.id,
      tool: call.name,
      ok,
      label,
      output: output ?? { text: text.slice(0, 2000) },
      durationMs,
    });
    try {
      ctx.app.repos.usage.addToolInvocation({
        sessionId: ctx.session.id,
        agentId: cfg.agentId,
        role: cfg.role,
        tool: call.name,
        ok,
        durationMs,
        resultChars: text.length,
        clientId: ctx.session.clientId,
        userId: ctx.session.userId,
      });
    } catch (e) {
      ctx.app.log.debug({ err: (e as Error).message }, 'tool telemetry write failed');
    }
    const reminders = formatReminders(ctx.runtime.remindersFor(ctx, call.name));
    return { type: 'tool_result', toolUseId: call.id, content: (text || '(no output)') + reminders, isError: !ok };
  }

  private push(m: LlmMessage): void {
    this.messages.push(m);
    if (this.cfg.persistent) this.ctx.app.repos.messages.append(this.ctx.session.id, this.cfg.agentId, m.role, m);
  }

  private replaceMessages(messages: LlmMessage[]): void {
    this.messages = messages;
    // The conversation was rewritten: any memoised read may now point at text that is gone.
    this.readMemo.clear();
    if (this.cfg.persistent) this.ctx.app.repos.messages.replace(this.ctx.session.id, this.cfg.agentId, toStoredMessages(this.messages));
  }

  /** Proactive compaction once history passes ~55% of the context window. */
  private async maybeCompact(): Promise<void> {
    const window = this.cfg.model.contextWindow || 200_000;
    const est = estimateTokens(this.messages);
    const budget = Math.floor(window * 0.55);
    if (est >= budget && this.messages.length >= 8) await this.compactNow(0.55);
    // Measured after compaction: what matters to the user is how much room is left once the loop
    // has done everything it can, not the peak it reached before compacting. Only the persistent
    // orchestrator conversation can outgrow the window across turns; sub-agents start empty.
    if (this.cfg.persistent) this.ctx.runtime.noteContextPressure(this.ctx.session.id, estimateTokens(this.messages), window);
  }

  /**
   * Compaction the user asked for (the Compact button), using the same two-stage path as the loop.
   * Targets the hard ratio, since someone pressing the button wants room, not a trim.
   */
  async compactOnDemand(): Promise<{ ok: boolean; beforeTokens: number; afterTokens: number }> {
    const beforeTokens = estimateTokens(this.messages);
    const ok = await this.compactNow(0.35);
    return { ok, beforeTokens, afterTokens: estimateTokens(this.messages) };
  }

  /**
   * Two-stage context reduction. First evict superseded tool-result bodies by id — cheap, and it
   * keeps every assistant decision intact. Only if that is not enough do we pay for a full
   * summarisation, which loses granularity.
   *
   * The summarised head is cut at an assistant message, so the tail — the most recent tool pairs,
   * including the validation failure the model is fixing right now — is kept verbatim. Cutting
   * forward to the next user text message would, in a builder loop, summarise everything.
   */
  private async compactNow(targetRatio: number): Promise<boolean> {
    const window = this.cfg.model.contextWindow || 200_000;
    const target = Math.floor(window * targetRatio);

    const pruned = evictSupersededToolResults(this.messages);
    if (pruned !== this.messages) {
      this.replaceMessages(pruned);
      if (estimateTokens(this.messages) < target) return true;
    }
    const boundary = compactionBoundary(this.messages, COMPACTION_KEEP_TAIL);
    if (boundary === null) return false;
    const head = this.messages.slice(0, boundary);
    const tail = this.messages.slice(boundary);
    const summarize = this.ctx.app.ai.resolve('summarizer', this.ctx.session.userId);
    const transcript = head
      .map((m) => `${m.role.toUpperCase()}: ${m.content.map(blockToText).join('\n')}`)
      .join('\n\n')
      .slice(0, 400_000);
    const prompt = this.cfg.compactInstructions
      ? `${COMPACTION_SYSTEM_PROMPT}\n\nAdditional instructions from this client for what the summary must keep:\n${this.cfg.compactInstructions}`
      : COMPACTION_SYSTEM_PROMPT;
    // The summariser is a model call like any other: it is projected and refused before it runs,
    // and it honours the abort signal, so a cancelled turn does not keep spending.
    const ceiling = this.checkCeiling(projectCallCostUsd(summarize.model, Math.ceil((prompt.length + transcript.length) / 4), COMPACTION_OUTPUT_TOKENS));
    if (ceiling) throw ceiling;
    const started = Date.now();
    const r = await summarize.provider.complete({
      model: summarize.model,
      system: prompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
      tools: [],
      effort: 'low',
      maxTokens: COMPACTION_OUTPUT_TOKENS,
      signal: this.ctx.signal,
    });
    const cost = this.ctx.app.ai.cost(summarize.model, r.usage);
    this.ctx.app.repos.usage.add({
      sessionId: this.ctx.session.id,
      userId: this.ctx.session.userId,
      clientId: this.ctx.session.clientId,
      role: 'summarizer',
      provider: summarize.model.provider,
      modelId: summarize.model.modelId,
      ...r.usage,
      costUsd: cost,
      durationMs: Date.now() - started,
    });
    this.ctx.app.repos.sessions.addUsage(this.ctx.session.id, { ...r.usage, costUsd: cost });
    this.ctx.runtime.addTurnCost(this.ctx.session.id, cost);
    const summary = stripAnalysis(
      r.content
        .filter((b) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n'),
    );
    // The transcript that was summarised stays reachable: a detail the summary dropped is one
    // read_tool_output away instead of gone.
    let handle: string | null = null;
    try {
      handle = this.persistArtifact('compaction', transcript);
    } catch {
      handle = null;
    }
    const header = `[Conversation so far, compacted${handle ? `. The full transcript is saved as artifact ${handle}; read it with read_tool_output if a detail below is missing` : ''}]`;
    this.replaceMessages([{ role: 'user', content: [{ type: 'text', text: `${header}\n${summary}\n\n${COMPACTION_RESUME_LINE}` }] }, ...tail]);
    return true;
  }
}

/**
 * Where to cut for summarisation: the latest assistant message at least `keepTail` messages from
 * the end. The summary becomes a user message and the tail starts with that assistant message, so
 * every tool_use keeps its tool_result and both protocols accept the sequence. Null when the
 * conversation is too short to have a head worth summarising.
 */
export function compactionBoundary(messages: LlmMessage[], keepTail: number): number | null {
  for (let i = messages.length - keepTail; i >= 1; i--) {
    if (messages[i].role === 'assistant') return i;
  }
  return null;
}

/** A stable fingerprint of a validation's failure set, for stuck-loop detection. */
function validationSignature(output: unknown): string {
  const o = output as
    | { failures?: { componentType?: string | null; fullName?: string | null; lineNumber?: number | null; problem?: string }[]; error?: string }
    | undefined;
  if (Array.isArray(o?.failures) && o.failures.length) {
    return o.failures
      .map((f) => `${f.componentType ?? ''}|${f.fullName ?? ''}|${f.lineNumber ?? ''}|${(f.problem ?? '').trim()}`)
      .sort()
      .join('\n');
  }
  return `error:${o?.error ?? 'unknown'}`;
}

/**
 * Pure reads worth memoising within a run. Deliberately conservative: only calls whose answer
 * cannot change unless something else in the run mutates state.
 */
const DEDUPABLE_READS = new Set([
  'describe_sobject',
  'read_metadata',
  'list_metadata',
  'list_metadata_types',
  'list_sobjects',
  'search_memory',
  'read_product_doc',
  'search_product_docs',
  'load_skill',
]);

/** Rough token estimate; deliberately conservative so compaction fires slightly early. */
export function estimateTokens(messages: LlmMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Placeholder left where a superseded tool result used to be. */
export const EVICTED_RESULT_TEXT = '[Earlier tool output removed to free context. Re-run the tool if you still need it.]';
/** Tool results newer than this are never evicted — the model is probably still working with them. */
export const KEEP_RECENT_RESULTS = 8;
/** Small results are not worth evicting; the placeholder costs nearly as much. */
const EVICT_MIN_CHARS = 2000;

/**
 * Replace the bodies of old, large tool results with a short placeholder, keeping the message
 * structure (and therefore every tool_use/tool_result pairing) intact. Much cheaper than
 * summarising, and it preserves recent fidelity where the model is actually working.
 */
export function evictSupersededToolResults(messages: LlmMessage[]): LlmMessage[] {
  const positions: { mi: number; bi: number; len: number }[] = [];
  messages.forEach((m, mi) =>
    m.content.forEach((b, bi) => {
      if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length >= EVICT_MIN_CHARS && b.content !== EVICTED_RESULT_TEXT) {
        positions.push({ mi, bi, len: b.content.length });
      }
    }),
  );
  const evictable = positions.slice(0, Math.max(0, positions.length - KEEP_RECENT_RESULTS));
  if (!evictable.length) return messages;
  const out = messages.map((m) => ({ ...m, content: [...m.content] }));
  for (const p of evictable) {
    const block = out[p.mi].content[p.bi] as Extract<LlmBlock, { type: 'tool_result' }>;
    out[p.mi].content[p.bi] = { ...block, content: EVICTED_RESULT_TEXT };
  }
  return out;
}

/** Drop provider-specific raw content (thinking blocks with model-bound signatures). */
function stripProviderRaw(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) => (m.raw ? { role: m.role, content: m.content } : m));
}

function stableStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.keys(val)
            .sort()
            .reduce((acc: any, k) => {
              acc[k] = (val as any)[k];
              return acc;
            }, {})
        : val,
    );
  } catch {
    return String(v);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function blockToText(b: LlmBlock): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'tool_use':
      return `[tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 2000)}]`;
    case 'tool_result':
      return `[tool_result${b.isError ? ' ERROR' : ''}: ${b.content.slice(0, 4000)}]`;
    case 'thinking':
      return '';
  }
}
function safeInput(input: unknown): unknown {
  try {
    const s = JSON.stringify(input);
    return s.length > 20_000 ? { _truncated: s.slice(0, 20_000) } : input;
  } catch {
    return String(input);
  }
}
