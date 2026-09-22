import type {
  AgentRole,
  BrowserCaptureKind,
  BrowserCaptureResponse,
  Client,
  DeployRun,
  DocEntry,
  ImpactCommand,
  OrgLimits,
  PageContext,
  SessionSnapshot,
  UiMode,
  WorkspaceFile,
} from '@sf-claws/shared';
import type { AppContext } from '../app-context.js';
import type { OrgRow, SessionRow } from '../db/repos/index.js';
import { SessionEventBus } from './events.js';
import { AgentRun } from './agent.js';
import { toolsForRole, normalizePath, READ_ONLY_SUBAGENT_ROLES, type ToolContext } from './tools.js';
import { inferComponentFromPath, sourcePathFor } from '@sf-claws/shared';
import { buildPromptSections, buildMemoryIndex, compactInstructionsFrom, parseReviewVerdict, MEMORY_INDEX_MAX_LINES, type ReviewVerdict } from './prompts.js';
import { PromptCacheProbe, hashText, type PromptSection } from './cache-probe.js';
import { answerOrphanedQuestions, toStoredMessages } from './conversation.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { newId, sha256 } from '../lib/crypto.js';
import { sessionBranchName } from '../github/service.js';
import { checkCostCeilings, monthStartIso, type CostCeilingError } from './cost.js';
import type { CustomAgent } from '@sf-claws/shared';
import { buildReminders, BUDGET_REMINDER_FRACTIONS } from './reminders.js';
import { deploySubjects, permissionBlockedMessage, permissionRefusalText } from './policy.js';
import type { TestLevel, DeployOutcome } from '../salesforce/service.js';
import { FactCache, OrgReadLimiter } from './fact-cache.js';
import { preHydrate, hydrationPrompt } from './pre-hydration.js';
import { toolingEligible } from '../salesforce/tooling-compile.js';
import { executeCheckpoint, classifyFailure } from './validation-recovery.js';
import {
  applyCompileResult,
  compileDue,
  compileHash,
  compileSlice,
  componentKey,
  fileHash,
  missingCompanions,
  COMPILE_INTERVAL_MS,
  repairComponents,
  rootDiagnostics,
} from './compile-control.js';

interface ActiveTurn {
  abort: AbortController;
  promise: Promise<void>;
  originals: Map<string, string>;
  docsWritten: number;
  toolCalls: number;
  /** Spend inside this turn, for the per-turn ceiling. */
  costUsd: number;
  /** Tool calls since the lead agent last updated the todo list (drift detection). */
  callsSinceTodoWrite: number;
  /** True when the agent asked the user something and got no usable answer — do not nudge it on. */
  awaitingUser: boolean;
  /** Bus subscriptions this turn opened; released when the turn ends, however it ends. */
  unsubscribers: (() => void)[];
  /** Tool calls with interruptBehavior 'block' still running; a cancel waits for these. */
  blocking: Set<Promise<unknown>>;
  /** The org-limit warning the agents were last reminded about, so the reminder fires once per change. */
  orgLimitWarned: string | null;
  /** callsSinceTodoWrite at the moment the todo nudge last fired. */
  todoRemindedAt: number;
  /** Tool calls per agent in this turn, for the sparse per-agent reminders. */
  agentCalls: Map<string, number>;
  /** "scope:fraction" budget thresholds already reminded about this turn. */
  budgetRemindedAt: Set<string>;
}

/** Scratchpad note under which the latest reviewer verdict is kept (persisted, visible, no schema). */
export const REVIEW_VERDICT_NOTE = 'Reviewer verdict';
/** Scratchpad note that accumulates every rejected plan; see `logPlanRevision`. */
export const PLAN_REVISIONS_NOTE = 'Plan revisions';
/** How long a tool waits for the panel to answer a capture request before giving up on it. */
const BROWSER_CAPTURE_TIMEOUT_MS = 15_000;

interface Waiter {
  resolve: (optionId: string, byUserId?: string) => void;
}

/** What a confirmation card came back with. */
interface ConfirmationAnswer {
  optionId: string;
  byUserId: string | null;
  confirmationId: string;
}

/**
 * Orchestrates sessions: runs the orchestrator agent per user message, spawns sub-agents,
 * gates deploys/commits behind user confirmations and guarantees documentation.
 */
export class SessionRuntime {
  readonly bus: SessionEventBus;
  private active = new Map<string, ActiveTurn>();
  private waiters = new Map<string, Waiter>();
  /** In-flight browser capture requests, keyed by requestId. See `captureBrowser`. */
  private browserWaiters = new Map<string, { sessionId: string; resolve: (r: BrowserCaptureResponse) => void }>();
  /**
   * Fingerprint of the staged workspace at the moment its validation succeeded, per session. In
   * memory on purpose: there is no column to persist it in, and a restart loses the running turn
   * anyway (`recoverOnBoot`). The approved fingerprint is persisted in the confirmation payload,
   * so an orphaned deploy answered after a restart still has a baseline to compare against.
   */
  private validatedFingerprints = new Map<string, WorkspaceFingerprint>();
  /** Context-pressure levels already announced for a session, so the warning is not repeated every turn. */
  private contextWarned = new Map<string, Set<'warning' | 'critical'>>();
  private idleSweep: ReturnType<typeof setInterval> | null = null;
  /** Cache-break detection across calls; keyed per session and agent. */
  readonly cacheProbe = new PromptCacheProbe();
  readonly facts = new FactCache();
  private readLimiter = new OrgReadLimiter();
  hydrationPrompt(sessionId: string): string {
    return hydrationPrompt(this.app, sessionId);
  }
  async hydrateContext(sessionId: string, targets: string): Promise<string> {
    await preHydrate(this.app, sessionId, targets, true);
    return this.hydrationPrompt(sessionId);
  }
  factIdentity(sessionId: string): string {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const org = this.app.repos.orgs.byId(session.orgId)!;
    return JSON.stringify([
      session.clientId,
      org.id,
      session.userId,
      org.username,
      org.sfOrgId,
      org.instanceUrl,
      org.consumerKey,
      org.lastConnectedAt,
      org.status,
      org.apiVersion,
      this.app.repos.harness.revision(org.id),
    ]);
  }
  readFact<T>(sessionId: string, resource: string, loader: () => Promise<T>): Promise<T> {
    const orgId = this.app.repos.sessions.byId(sessionId)!.orgId;
    return this.facts.read(`${this.factIdentity(sessionId)}:${resource}`, () => this.readLimiter.run(orgId, loader));
  }
  factFetchedAt(sessionId: string, resource: string): string {
    return new Date(this.facts.fetchedAt(`${this.factIdentity(sessionId)}:${resource}`) ?? Date.now()).toISOString();
  }
  private orgCommands = new Map<string, Promise<void>>();
  private compiling = new Set<string>();
  private pendingCompiles = new Map<string, Promise<DeployRun>>();
  private compileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private app!: AppContext;

  constructor(app: Omit<AppContext, 'runtime'>) {
    this.app = app as AppContext;
    this.bus = new SessionEventBus(app.repos);
  }
  bind(app: AppContext): void {
    this.app = app;
  }

  // ------------------------------------------------------------ lifecycle
  async reconcileCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
    const checkpoint = this.app.repos.harness.get(sessionId, checkpointId);
    if (!checkpoint) throw notFound('Checkpoint');
    if (!['in_progress', 'uncertain'].includes(checkpoint.status)) return;
    await this.orgCommand(checkpoint.orgId, async () => {
      if (!['in_progress', 'uncertain'].includes(this.app.repos.harness.get(sessionId, checkpoint.id)!.status)) return;
      this.compiling.add(sessionId);
      try {
        const outcome = await executeCheckpoint(this.app, checkpoint);
        this.app.repos.harness.finish(sessionId, checkpoint.id, outcome.ok ? 'succeeded' : 'failed', rootDiagnostics(outcome.failures).length);
        this.app.repos.deploys.update(checkpoint.deployId, {
          status: outcome.ok ? 'succeeded' : 'failed',
          sfDeployId: outcome.sfDeployId,
          failures: outcome.failures,
          completedAt: new Date().toISOString(),
        });
        if (!checkpoint.checkOnly) this.app.repos.harness.invalidate(checkpoint.orgId);
        const state = this.app.repos.compileControl.get(sessionId);
        state.stopped = 'Archived job reconciled. Run a fresh full validation of the current workspace before resuming.';
        this.app.repos.compileControl.set(sessionId, state);
        this.validatedFingerprints.delete(sessionId);
      } finally {
        this.compiling.delete(sessionId);
      }
    });
  }
  createSession(input: {
    userId: string;
    orgId: string;
    projectId?: string;
    taskId?: string;
    title?: string;
    uiMode: UiMode;
    pageContext?: unknown;
  }): SessionRow {
    const org = this.app.repos.orgs.byId(input.orgId);
    if (!org) throw notFound('Org');
    if (input.taskId && !this.app.repos.tasks.byId(input.taskId)) throw notFound('Task');
    // A plain "New session" reuses the caller's newest untouched one on this org rather than piling up blanks.
    if (!input.taskId && !input.projectId && !input.title) {
      const blank = this.app.repos.sessions
        .list({ userId: input.userId, orgId: org.id, status: 'idle', limit: 20 })
        .find((s) => !s.taskId && !s.projectId && !this.active.has(s.id) && !this.app.repos.events.hasType(s.id, 'user.message'));
      if (blank) return this.app.repos.sessions.update(blank.id, { pageContext: input.pageContext })!;
    }
    const title =
      input.title?.trim() ||
      (input.taskId
        ? this.app.repos.tasks.byId(input.taskId)!.title
        : `Session ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`);
    const s = this.app.repos.sessions.create({
      userId: input.userId,
      clientId: org.clientId,
      orgId: org.id,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      title,
      uiMode: input.uiMode,
      pageContext: input.pageContext,
    });
    this.bus.emit(s.id, { type: 'session.status', status: 'idle', message: 'Session created' });
    this.app.repos.audit.log({ userId: input.userId, action: 'session.create', target: s.id, details: { orgId: org.id } });
    return s;
  }

  /** The user marks the session done. Emitted as a status event so an open panel updates live. */
  completeSession(sessionId: string): SessionRow {
    this.setStatus(sessionId, 'completed', 'Completed by user');
    return this.app.repos.sessions.byId(sessionId)!;
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Start (or continue) a turn with a user message. Returns immediately; work runs in background. */
  startTurn(sessionId: string, userId: string, text: string): void {
    const session = this.app.repos.sessions.byId(sessionId);
    if (!session) throw notFound('Session');
    if (this.active.has(sessionId)) throw conflict('Session is already running. Wait for it to finish or cancel it.');
    if (['completed', 'cancelled'].includes(session.status) && session.status === 'cancelled') {
      /* allow resume */
    }
    const org = this.app.repos.orgs.byId(session.orgId);
    if (!org) throw notFound('Org');
    if (org.status !== 'connected') throw new HttpError(409, 'ORG_DISCONNECTED', `Org "${org.label}" is ${org.status}. An admin must (re)connect it.`);
    this.bus.emit(sessionId, { type: 'user.message', userId, text });
    if (session.title.startsWith('Session ') && this.app.repos.events.listAfter(sessionId).filter((e) => e.type === 'user.message').length === 1) {
      this.app.repos.sessions.update(sessionId, { title: text.replace(/\s+/g, ' ').slice(0, 80) });
    }
    const abort = new AbortController();
    const turn: ActiveTurn = {
      abort,
      promise: Promise.resolve(),
      originals: new Map(),
      docsWritten: 0,
      toolCalls: 0,
      costUsd: 0,
      callsSinceTodoWrite: 0,
      awaitingUser: false,
      unsubscribers: [],
      blocking: new Set(),
      orgLimitWarned: null,
      todoRemindedAt: 0,
      agentCalls: new Map(),
      budgetRemindedAt: new Set(),
    };
    this.active.set(sessionId, turn);
    const dirtyPath = this.app.repos.compileControl.get(sessionId).dirtyPaths[0];
    if (dirtyPath) this.noteWorkspaceChange(sessionId, dirtyPath);
    turn.promise = this.runTurn(sessionId, text, turn)
      .catch((e) => {
        this.app.log.error({ err: e, sessionId }, 'turn failed');
        this.bus.emit(sessionId, { type: 'session.error', agentId: null, message: (e as Error).message, recoverable: false });
        this.setStatus(sessionId, 'failed', (e as Error).message);
      })
      .finally(() => {
        clearTimeout(this.compileTimers.get(sessionId));
        this.compileTimers.delete(sessionId);
        // Every listener the turn opened goes with it: a completed turn must not keep counting
        // the next turn's tool calls, nor keep a closure alive per turn for the life of the process.
        for (const unsub of turn.unsubscribers.splice(0)) unsub();
        this.active.delete(sessionId);
      });
  }

  private async runTurn(sessionId: string, text: string, turn: ActiveTurn): Promise<void> {
    this.setStatus(sessionId, 'running', null);
    const session = this.app.repos.sessions.byId(sessionId)!;
    const unresolved = this.app.repos.harness.active(session.orgId);
    if (unresolved) {
      this.setStatus(sessionId, 'failed', `Unresolved remote operation in checkpoint ${unresolved.id}. Reconcile it before starting an agent.`);
      return;
    }
    if (!this.app.repos.compileControl.get(sessionId).stopped) await preHydrate(this.app, sessionId, text);
    if (turn.abort.signal.aborted) {
      this.setStatus(sessionId, 'cancelled', 'Cancelled during hydration');
      return;
    }
    const ctx = this.toolContext(sessionId, { id: 'orchestrator', role: 'orchestrator', parentId: null }, turn);
    const limits = await this.refreshLimits(sessionId).catch(() => null);
    if (limits?.warnings.length)
      text += `\n\n[Harness notice: org limits approaching thresholds — ${limits.warnings.join('; ')}. Be economical with API calls and warn the user if the work is API-heavy.]`;
    const resolved = this.app.ai.resolve('orchestrator', ctx.session.userId);
    // A plan approval or a question answered after a restart is delivered here, as the result of
    // the tool call that asked, so the model continues from the answer instead of asking again.
    this.deliverOrphanedAnswers(sessionId);
    const prompt = await this.systemPrompt('orchestrator', ctx);
    const agent = new AgentRun(
      {
        agentId: 'orchestrator',
        parentId: null,
        role: 'orchestrator',
        model: resolved.model,
        provider: resolved.provider,
        effort: resolved.effort,
        maxIterations: resolved.maxIterations,
        system: prompt.system,
        promptSections: prompt.sections,
        tools: toolsForRole('orchestrator'),
        persistent: true,
        fallback: resolved.fallback,
        compactInstructions: compactInstructionsFrom(ctx.client.instructions),
      },
      ctx,
    );
    let outcome = await agent.run(text);
    if (turn.abort.signal.aborted) {
      this.setStatus(sessionId, 'cancelled', 'Cancelled by user');
      return;
    }
    // Completion drive: the lead agent may not stop with open todo items unless it is explicitly waiting on the user.
    for (let nudges = 0; nudges < 2 && outcome.stoppedBy === 'end_turn' && !turn.abort.signal.aborted; nudges++) {
      const open = this.app.repos.todos.get(sessionId).filter((t) => t.status === 'pending' || t.status === 'in_progress');
      if (!open.length || turn.awaitingUser || this.waitingOnUser(outcome.text)) break;
      this.bus.emit(sessionId, { type: 'session.status', status: 'running', message: `${open.length} todo item(s) still open — continuing` });
      outcome = await agent.run(
        `[Harness] Your todo list still has open items:\n${open.map((t) => `- [${t.status}] ${t.content}`).join('\n')}\nEither continue the work now, or if you genuinely need something from the user, end with a clear question starting with "QUESTION FOR YOU:"; if an item cannot be done, mark it blocked with the reason via todo_write. Do not stop with items silently open.`,
      );
    }
    // Documentation guarantee: if meaningful work happened without docs, generate them.
    const workspace = this.app.repos.workspace.list(sessionId);
    const meaningful = workspace.length > 0 || turn.toolCalls >= 4;
    const compileStop = this.app.repos.compileControl.get(sessionId).stopped;
    if (compileStop) {
      this.bus.emit(sessionId, { type: 'assistant.message', agentId: 'orchestrator', role: 'orchestrator', messageId: newId('am'), text: compileStop });
      this.setStatus(sessionId, 'failed', compileStop);
      return;
    }
    if (meaningful && turn.docsWritten === 0 && !turn.abort.signal.aborted) {
      try {
        await this.runSubagent(
          sessionId,
          'orchestrator',
          'doc_writer',
          `Document this session turn. The user asked: "${text.slice(0, 1000)}". The lead agent's final reply was: "${outcome.text.slice(0, 3000)}". Cover the investigation and any staged/validated/deployed changes.`,
        );
      } catch (e) {
        this.app.log.warn({ err: e }, 'auto documentation failed');
      }
    }
    const failed = outcome.stoppedBy === 'provider_error' || outcome.stoppedBy === 'context_exhausted';
    this.setStatus(sessionId, failed ? 'failed' : 'idle', outcome.stoppedBy === 'end_turn' ? null : stopReasonMessage(outcome.stoppedBy));
  }

  /** Heuristic: the lead agent explicitly asked the user something / needs a decision. */
  private waitingOnUser(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (/QUESTION FOR YOU:/i.test(t)) return true;
    const lastLines = t.split('\n').slice(-3).join(' ');
    return /\?\s*$/.test(lastLines) || /\b(please confirm|let me know|would you like|do you want|which (one|option)|should i)\b/i.test(lastLines);
  }

  cancel(sessionId: string, userId: string): void {
    const turn = this.active.get(sessionId);
    const pending = this.app.repos.confirmations.pending(sessionId);
    for (const c of pending) {
      this.app.repos.confirmations.resolve(c.id, 'cancel', userId);
      this.waiters.get(c.id)?.resolve('cancel');
      this.waiters.delete(c.id);
    }
    if (!turn) {
      this.setStatus(sessionId, 'idle', 'Nothing running');
      return;
    }
    turn.abort.abort();
    this.markInterruptedTodosBlocked(sessionId);
    if (turn.blocking.size) {
      // A deploy, a commit or a record write in flight runs to completion and records its result;
      // marking the session cancelled first would tell the user "stopped" while the org changes.
      this.bus.emit(sessionId, {
        type: 'session.status',
        status: 'running',
        message: `Cancelling — waiting for ${turn.blocking.size} command(s) that cannot be interrupted to finish`,
      });
      void Promise.allSettled([...turn.blocking]).then(() => {
        if (this.app.repos.sessions.byId(sessionId)?.status !== 'cancelled') this.setStatus(sessionId, 'cancelled', 'Cancelled by user');
      });
      return;
    }
    this.setStatus(sessionId, 'cancelled', 'Cancelled by user');
  }

  /** Register an in-flight blocking tool call (interruptBehavior 'block') so cancel() waits for it. */
  trackBlocking(sessionId: string, pending: Promise<unknown>): void {
    const turn = this.active.get(sessionId);
    if (!turn) return;
    turn.blocking.add(pending);
    void pending.finally(() => turn.blocking.delete(pending)).catch(() => undefined);
  }

  private setStatus(sessionId: string, status: SessionRow['status'], message: string | null): void {
    this.app.repos.sessions.update(sessionId, { status, completedAt: status === 'completed' ? new Date().toISOString() : undefined });
    this.bus.emit(sessionId, { type: 'session.status', status, message });
  }

  /**
   * Whether the workspace changed after the latest validation started. Derived from persisted
   * state — the last `workspace.file` event against the validation row's `createdAt` — rather than
   * an in-memory flag, so it survives a restart: validate → stage → restart → Deploy must refuse.
   */
  workspaceDirty(sessionId: string): boolean {
    const last = this.app.repos.deploys.latest(sessionId, true);
    const changedAt = this.lastWorkspaceChangeAt(sessionId);
    if (!changedAt) return false;
    if (!last) return true;
    return changedAt > last.createdAt;
  }

  /**
   * @deprecated Dirtiness is derived from the persisted `workspace.file` events (see
   * `workspaceDirty`); callers only need to emit that event. Kept so existing callers compile.
   */
  markWorkspaceDirty(_sessionId: string): void {
    /* no in-memory state to set */
  }

  /** Timestamp of the most recent workspace.file event, scanning the event log backwards in pages. */
  private lastWorkspaceChangeAt(sessionId: string): string | null {
    const PAGE = 200;
    let end = this.app.repos.events.lastSeq(sessionId);
    while (end > 0) {
      const from = Math.max(0, end - PAGE);
      const page = this.app.repos.events.listAfter(sessionId, from, PAGE);
      for (let i = page.length - 1; i >= 0; i--) if (page[i].type === 'workspace.file') return page[i].at;
      end = from;
    }
    return null;
  }

  /**
   * Record where the user is now. The extension sends this with every message, because over a long
   * session people move around the org and an agent still reasoning about the record they opened an
   * hour ago is worse than one with no page context at all. Stored on the session, so the next
   * turn's prompt (and any sub-agent started in it) sees the current page.
   */
  updatePageContext(sessionId: string, pageContext: PageContext): void {
    const session = this.app.repos.sessions.byId(sessionId);
    if (!session) return;
    const next = Object.fromEntries(Object.entries(pageContext).filter(([, v]) => v !== undefined && v !== ''));
    if (!Object.keys(next).length) return;
    if (JSON.stringify(next) === JSON.stringify(session.pageContext ?? {})) return;
    this.app.repos.sessions.update(sessionId, { pageContext: next });
    this.bus.emit(sessionId, { type: 'session.page', pageContext: next });
  }

  // ------------------------------------------------------------ agents
  private toolContext(sessionId: string, agent: ToolContext['agent'], turn: ActiveTurn, research?: ToolContext['research']): ToolContext {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const org = this.app.repos.orgs.byId(session.orgId)!;
    const client = this.app.repos.clients.byId(session.clientId)!;
    const rules = this.app.policy.effective(session.clientId);
    const ctx: ToolContext = {
      app: this.app,
      runtime: this,
      session,
      org,
      client,
      rules,
      agent,
      signal: turn.abort.signal,
      originals: turn.originals,
      research,
    };
    // count tool calls through the bus for the documentation guarantee
    const unsub = this.bus.subscribe(sessionId, (ev) => {
      if (ev.type === 'tool.call') {
        turn.toolCalls++;
        turn.callsSinceTodoWrite = ev.tool === 'todo_write' ? 0 : turn.callsSinceTodoWrite + 1;
      }
      if (ev.type === 'doc.written') turn.docsWritten++;
    });
    turn.unsubscribers.push(unsub);
    return ctx;
  }

  /**
   * The system prompt and its named sections. The objective of a sub-agent is not part of it: it
   * goes in the first user message, so sub-agents with different objectives share one cached
   * prefix (`prompts.ts` explains the ordering).
   */
  private async systemPrompt(role: AgentRole, ctx: ToolContext, specialist?: CustomAgent): Promise<{ system: string; sections: PromptSection[] }> {
    const sections = buildPromptSections({
      role,
      client: ctx.client,
      org: ctx.org,
      session: ctx.session,
      rules: ctx.rules,
      skillsSection: this.app.skills.promptSection(role, ctx.session.clientId, ctx.org.id),
      // An index, not the documents: full text comes from search_memory when it is actually needed.
      memoryIndex: buildMemoryIndex(this.app.repos.docs.byOrg(ctx.org.id, MEMORY_INDEX_MAX_LINES)),
      knowledgeSection: await this.app.knowledge.promptSection(ctx.session.clientId),
      specialists: role === 'orchestrator' ? this.app.repos.customAgents.forClient(ctx.session.clientId) : [],
      githubConfigured: this.app.github.hasToken(ctx.session.clientId),
      tools: toolsForRole(role).map((t) => t.name),
      specialistInstructions: specialist ? { name: specialist.name, instructions: specialist.instructions } : null,
    });
    sections.push({ name: 'hydration', text: this.hydrationPrompt(ctx.session.id) });
    return { system: sections.map((x) => x.text).join('\n\n'), sections };
  }

  async runSubagent(
    sessionId: string,
    parentId: string,
    role: AgentRole,
    objective: string,
    context?: string,
    research?: { sourceId: string; thoroughness: string },
    specialist?: CustomAgent,
  ): Promise<{ agentId: string; report: string; ok: boolean }> {
    const turn = this.active.get(sessionId);
    if (!turn) throw new Error('No active turn');
    const stopped = this.app.repos.compileControl.get(sessionId).stopped;
    if (stopped) return { agentId: parentId, report: stopped, ok: false };
    if (role === 'orchestrator' || role === 'summarizer') throw badRequest('Cannot delegate to that role');
    const agentId = newId(role);
    // A researcher's file-read budget scales with the thoroughness the caller asked for: without a
    // ceiling an open-ended question can read a whole repository into the context window.
    const scope = research
      ? { sourceId: research.sourceId, readBudget: { used: 0, max: READ_BUDGETS[research.thoroughness] ?? READ_BUDGETS.medium } }
      : undefined;
    const ctx = this.toolContext(sessionId, { id: agentId, role, parentId }, turn, scope);
    const resolved = this.app.ai.resolve(role, ctx.session.userId);
    this.bus.emit(sessionId, { type: 'agent.spawned', agentId, parentAgentId: parentId, role, modelId: resolved.model.modelId, objective });
    // A specialist's instructions are appended to the base role's prompt (in the dynamic half),
    // never substituted for it: the role's safety rules and tool guidance must survive whatever
    // an admin writes.
    const system = await this.systemPrompt(role, ctx, specialist);
    const agent = new AgentRun(
      {
        agentId,
        parentId,
        role,
        model: resolved.model,
        provider: resolved.provider,
        effort: resolved.effort,
        // Thoroughness bounds the researcher's steps as well as its reads: a "quick" question must
        // not be allowed forty iterations of searching.
        maxIterations: research
          ? Math.min(resolved.maxIterations, ITERATION_BUDGETS[research.thoroughness] ?? ITERATION_BUDGETS.medium)
          : resolved.maxIterations,
        system: system.system,
        promptSections: system.sections,
        tools: toolsForRole(role),
        persistent: false,
        fallback: resolved.fallback,
        compactInstructions: compactInstructionsFrom(ctx.client.instructions),
      },
      ctx,
    );
    const staged = this.app.repos.workspace.list(sessionId);
    const prompt = [
      `## Your objective for this run\n${objective}`,
      context ? `Context from the lead agent:\n${context}` : '',
      staged.length
        ? `Files currently staged in the workspace:\n${staged.map((f) => `- ${f.action} ${f.path}`).join('\n')}`
        : 'The workspace is currently empty.',
      (() => {
        const t = this.app.repos.todos.get(sessionId);
        return t.length ? `Session todo list:\n${t.map((i) => `- [${i.status}] ${i.content}`).join('\n')}` : '';
      })(),
      (() => {
        const n = this.app.repos.notes.list(sessionId);
        return n.length ? `Scratchpad notes (read with scratchpad_read): ${n.map((x) => `"${x.title}"`).join(', ')}` : '';
      })(),
      role === 'doc_writer' ? `Session transcript summary:\n${this.transcriptSummary(sessionId)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      const outcome = await agent.run(prompt);
      if (role === 'reviewer') this.recordReviewVerdict(sessionId, agentId, outcome.text);
      this.bus.emit(sessionId, { type: 'agent.finished', agentId, role, ok: outcome.ok, summary: outcome.text.slice(0, 500) });
      return { agentId, report: outcome.text || '(no report)', ok: outcome.ok };
    } catch (e) {
      this.bus.emit(sessionId, { type: 'agent.finished', agentId, role, ok: false, summary: (e as Error).message });
      return { agentId, report: `Sub-agent failed: ${(e as Error).message}`, ok: false };
    }
  }

  /** A stable fingerprint of the staged workspace, so a verdict is tied to what was reviewed. */
  workspaceHash(sessionId: string): string {
    const files = this.app.repos.workspace.list(sessionId);
    return hashText(files.map((f) => `${f.action}:${f.path}:${hashText(f.content)}`).join('\n'));
  }

  /**
   * The reviewer's VERDICT line, parsed and kept with the workspace hash it applies to. Stored as
   * a scratchpad note: persisted, visible to the user and the agents, and no schema change. A
   * report without a verdict line records "none" so the gate can ask for a proper review.
   */
  private recordReviewVerdict(sessionId: string, agentId: string, report: string): void {
    const verdict = parseReviewVerdict(report);
    const hash = this.workspaceHash(sessionId);
    this.app.repos.notes.upsert({
      sessionId,
      agentId,
      role: 'reviewer',
      title: REVIEW_VERDICT_NOTE,
      content: `verdict: ${verdict ?? 'none'}\nworkspace: ${hash}\nagent: ${agentId}\nat: ${new Date().toISOString()}`,
      tags: ['review', verdict ?? 'none'],
    });
  }

  /**
   * Every plan the user sent back, kept as a scratchpad note titled "Plan revisions" and tagged
   * "lesson". The doc writer turns it into a Lesson section, so the next session sees why a design
   * was rejected instead of proposing it again. Appends; the note is the whole history.
   */
  private logPlanRevision(sessionId: string, line: string): void {
    const previous = this.app.repos.notes.byTitle(sessionId, PLAN_REVISIONS_NOTE)?.content ?? '';
    this.app.repos.notes.upsert({
      sessionId,
      agentId: 'orchestrator',
      role: 'orchestrator',
      title: PLAN_REVISIONS_NOTE,
      content: `${previous}${previous ? '\n' : ''}${new Date().toISOString()} ${line}`,
      tags: ['lesson', 'plan'],
    });
  }

  /** The latest recorded verdict, and whether it was given for the workspace as it is now. */
  latestReviewVerdict(sessionId: string): { verdict: ReviewVerdict | null; current: boolean } | null {
    const note = this.app.repos.notes.byTitle(sessionId, REVIEW_VERDICT_NOTE);
    if (!note) return null;
    const verdict = /^verdict:\s*(PASS|FAIL|PARTIAL)/m.exec(note.content)?.[1] as ReviewVerdict | undefined;
    const hash = /^workspace:\s*(\S+)/m.exec(note.content)?.[1];
    return { verdict: verdict ?? null, current: hash === this.workspaceHash(sessionId) };
  }

  /** Whether the workspace, as staged, is big enough to need a reviewer under the current policy. */
  private reviewRequired(sessionId: string): boolean {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const policy = this.app.policy.effective(session.clientId).requireReviewerVerdict;
    if (policy === 'never') return false;
    if (policy === 'always') return true;
    const files = this.app.repos.workspace.list(sessionId);
    if (files.some((f) => PLAN_REQUIRED_TYPES.has(f.metadataType ?? ''))) return true;
    return new Set(files.map((f) => f.fullName ?? f.path)).size > 1;
  }

  private transcriptSummary(sessionId: string): string {
    const events = this.app.repos.events.listAfter(sessionId, 0, 5000);
    const lines: string[] = [];
    for (const e of events) {
      if (e.type === 'user.message') lines.push(`USER: ${e.text.slice(0, 500)}`);
      else if (e.type === 'assistant.message' && e.role === 'orchestrator') lines.push(`LEAD: ${e.text.slice(0, 800)}`);
      else if (e.type === 'tool.call') lines.push(`  tool: ${e.label}`);
      else if (e.type === 'deploy.validation') lines.push(`  validation attempt ${e.attempt}: ${e.ok ? 'OK' : e.componentsFailed + ' failures'}`);
      else if (e.type === 'deploy.result') lines.push(`  DEPLOY ${e.ok ? 'SUCCEEDED' : 'FAILED'}: ${e.message}`);
      else if (e.type === 'github.commit') lines.push(`  COMMIT ${e.sha.slice(0, 7)} on ${e.branch}: ${e.message}`);
      else if (e.type === 'agent.finished') lines.push(`  agent ${e.role}: ${e.summary.slice(0, 300)}`);
    }
    const text = lines.join('\n');
    return text.length > 30_000 ? text.slice(-30_000) : text;
  }

  // ------------------------------------------------------------ validation / deploy
  /** A single coordinator serializes validation and deployment per org. */
  private async orgCommand<T>(orgId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.orgCommands.get(orgId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.orgCommands.set(orgId, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.orgCommands.get(orgId) === current) this.orgCommands.delete(orgId);
    }
  }

  workspaceWriteRefusal(sessionId: string, file: Pick<WorkspaceFile, 'path' | 'metadataType' | 'fullName'>, agent = true): string | null {
    if (this.compiling.has(sessionId) || this.pendingCompiles.has(sessionId))
      return 'Workspace is frozen while its immutable validation payload is queued or in flight. Wait for the compile result.';
    // A human can repair a stopped workspace; agents cannot reset the controller by replacing themselves.
    if (!agent) return null;
    const state = this.app.repos.compileControl.get(sessionId);
    if (state.stopped) return state.stopped;
    const key = componentKey(file);
    const existing = this.app.repos.workspace.list(sessionId);
    if (state.roots.length && !existing.some((f) => componentKey(f) === key))
      return `New components are blocked while ${state.roots.length} compile root error(s) remain. Repair and compile the current slice before adding ${key}.`;
    if (state.roots.length && !state.repairKeys.includes(key))
      return `Only failing components and their direct staged dependencies may be edited until compilation is green. Repair: ${state.roots.map((r) => r.key).join(', ')}.`;
    if (compileDue(state) && !existing.some((f) => componentKey(f) === key))
      return 'A compile is due (8 changed files or 10 minutes). Complete companion files for the current group and validate before adding another component.';
    return null;
  }

  noteWorkspaceChange(sessionId: string, path: string): void {
    const state = this.app.repos.compileControl.get(sessionId);
    const file = this.app.repos.workspace.get(sessionId, path);
    const changed = file ? state.checkedFiles[path] !== fileHash(file) : false;
    state.dirtyPaths = state.dirtyPaths.filter((p) => p !== path);
    if (changed) state.dirtyPaths.push(path);
    state.dirtySince = state.dirtyPaths.length ? (state.dirtySince ?? Date.now()) : null;
    this.app.repos.compileControl.set(sessionId, state);
    clearTimeout(this.compileTimers.get(sessionId));
    if (!this.active.has(sessionId) || state.stopped || state.dirtySince === null) return;
    const delay = compileDue(state) ? 0 : Math.max(0, state.dirtySince + COMPILE_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      void this.autoCompile(sessionId);
    }, delay);
    timer.unref();
    this.compileTimers.set(sessionId, timer);
  }

  /** Also called at model boundaries so resume/agent replacement cannot evade persisted cadence. */
  async autoCompile(sessionId: string): Promise<void> {
    const pending = this.pendingCompiles.get(sessionId);
    if (pending) {
      await pending.catch(() => undefined);
      return;
    }
    const state = this.app.repos.compileControl.get(sessionId);
    const turn = this.active.get(sessionId);
    if (!turn || turn.abort.signal.aborted || this.compiling.has(sessionId) || state.stopped || !compileDue(state)) return;
    if (this.app.repos.sessions.byId(sessionId)?.status !== 'running') return;
    const workspace = this.app.repos.workspace.list(sessionId);
    if (!workspace.length) return;
    const slice = compileSlice(workspace, state.dirtyPaths);
    if (!slice.length || missingCompanions(slice).length) return;
    try {
      await this.validate(sessionId, { paths: slice.map((f) => f.path), agentId: 'integrator' });
    } catch (e) {
      const latest = this.app.repos.compileControl.get(sessionId);
      latest.stopped = `Automatic compile stopped: ${(e as Error).message}. Staged work is preserved; resolve the issue and validate manually.`;
      this.app.repos.compileControl.set(sessionId, latest);
      this.bus.emit(sessionId, { type: 'session.error', agentId: null, message: latest.stopped, recoverable: true });
    }
  }

  validate(sessionId: string, opts: { testLevel?: TestLevel; runTests?: string[]; agentId?: string; paths?: string[] } = {}): Promise<DeployRun> {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const pending = this.orgCommand(session.orgId, async () => {
      if (opts.agentId && this.active.get(sessionId)?.abort.signal.aborted) throw badRequest('Session cancelled before compile submission.');
      this.compiling.add(sessionId);
      try {
        return await this.validateLocked(sessionId, opts);
      } finally {
        this.compiling.delete(sessionId);
      }
    });
    this.trackBlocking(sessionId, pending);
    this.pendingCompiles.set(sessionId, pending);
    const cleanup = () => {
      if (this.pendingCompiles.get(sessionId) === pending) this.pendingCompiles.delete(sessionId);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  private async validateLocked(
    sessionId: string,
    opts: { testLevel?: TestLevel; runTests?: string[]; agentId?: string; paths?: string[] },
  ): Promise<DeployRun> {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const org = this.app.repos.orgs.byId(session.orgId)!;
    const activeCheckpoint = this.app.repos.harness.active(org.id);
    if (activeCheckpoint) {
      if (opts.agentId || activeCheckpoint.sessionId !== sessionId || !activeCheckpoint.checkOnly)
        throw conflict(`Org has an unresolved job in checkpoint ${activeCheckpoint.id}; reconcile it before submitting new work.`);
      const reconciled = await executeCheckpoint(this.app, activeCheckpoint);
      this.app.repos.harness.finish(sessionId, activeCheckpoint.id, reconciled.ok ? 'succeeded' : 'failed', rootDiagnostics(reconciled.failures).length);
      this.app.repos.deploys.update(activeCheckpoint.deployId, {
        status: reconciled.ok ? 'succeeded' : 'failed',
        sfDeployId: reconciled.sfDeployId,
        failures: reconciled.failures,
        completedAt: new Date().toISOString(),
      });
      // Reconciliation never authorizes current files, which may have changed while the server was down.
      const state = this.app.repos.compileControl.get(sessionId);
      state.stopped = 'Archived job reconciled. Run a fresh full validation of the current workspace before resuming.';
      this.app.repos.compileControl.set(sessionId, state);
      this.validatedFingerprints.delete(sessionId);
      this.bus.emit(sessionId, { type: 'workspace.file', path: '[reconciled-checkpoint]', action: 'modified', metadataType: null, fullName: null });
      return this.app.repos.deploys.byId(activeCheckpoint.deployId)!;
    }
    const allFiles = this.app.repos.workspace.list(sessionId);
    if (opts.paths && (!opts.paths.length || opts.paths.some((p) => !allFiles.some((f) => f.path === p))))
      throw badRequest('Compile paths must name staged files.');
    const files = opts.paths ? compileSlice(allFiles, opts.paths) : allFiles;
    const scope = opts.paths ? ('slice' as const) : ('full' as const);
    if (!files.length) throw badRequest('Workspace is empty; nothing to validate.');
    const control = this.app.repos.compileControl.get(sessionId);
    if (opts.agentId && control.stopped) throw badRequest(control.stopped);
    const rules = this.app.policy.effective(session.clientId);
    const hasApex = files.some((f) => f.metadataType === 'ApexClass' || f.metadataType === 'ApexTrigger');
    let testLevel: TestLevel = opts.testLevel ?? (hasApex ? (org.kind === 'production' ? 'RunLocalTests' : 'RunSpecifiedTests') : 'NoTestRun');
    let runTests = opts.runTests ?? [];
    if (testLevel === 'RunSpecifiedTests' && !runTests.length) {
      runTests = files
        .filter((f) => f.metadataType === 'ApexClass' && /@IsTest/i.test(f.content))
        .map((f) => f.fullName!)
        .filter(Boolean);
      if (!runTests.length) testLevel = hasApex && rules.requireTestsForApex ? 'RunLocalTests' : 'NoTestRun';
    }
    const deleted = files
      .filter((f) => f.action === 'deleted' && f.path.startsWith('__destructive__/'))
      .map((f) => ({ type: f.metadataType!, fullName: f.fullName! }));
    const sourceFiles = files.filter((f) => f.action !== 'deleted').map((f) => ({ path: f.path, content: f.content }));
    const v = this.app.policy.checkDeploy(rules, org, session.uiMode, sourceFiles.length + deleted.length);
    if (v) throw new HttpError(422, 'POLICY', v.message);
    const members =
      scope === 'slice' &&
      org.kind !== 'production' &&
      (!opts.testLevel || opts.testLevel === 'NoTestRun') &&
      toolingEligible(files) &&
      this.app.sf.prepareToolingCompile
        ? await this.app.sf.prepareToolingCompile(org.id, files)
        : null;
    const engine = members ? ('tooling' as const) : ('metadata' as const);
    if (members) {
      testLevel = 'NoTestRun';
      runTests = [];
    }
    const hash = compileHash(files, { testLevel, runTests: [...runTests].sort() });
    if (opts.agentId && control.lastFailedHash === hash)
      throw badRequest('This unchanged payload already failed. Repair its root errors before compiling it again.');
    const zipBase64 = engine === 'metadata' && this.app.sf.prepareDeploy ? await this.app.sf.prepareDeploy(org.id, sourceFiles, deleted) : undefined;
    const run = this.app.repos.deploys.create({
      sessionId,
      orgId: org.id,
      checkOnly: true,
      testLevel,
      attempt: this.app.repos.deploys.nextAttempt(sessionId),
      scope,
    });
    this.app.repos.deploys.update(run.id, { status: 'in_progress' });
    const checkpoint = this.app.repos.harness.create({
      sessionId,
      orgId: org.id,
      deployId: run.id,
      engine,
      scope,
      checkOnly: true,
      comparisonKey: sha256(
        JSON.stringify([this.factIdentity(sessionId), engine, scope, files.map((f) => f.path).sort(), testLevel, [...runTests].sort(), rules.minCodeCoverage]),
      ),
      workspace: allFiles,
      control,
      payload: { apiVersion: org.apiVersion, files: sourceFiles, deleted, testLevel, runTests, zipBase64, members: members ?? undefined },
    });
    let outcome: DeployOutcome;
    try {
      outcome = await executeCheckpoint(this.app, checkpoint, {
        signal: this.active.get(sessionId)?.abort.signal,
        progress: (m) => this.bus.emit(sessionId, { type: 'session.status', status: 'running', message: `Validating: ${m}` }),
      });
    } catch (e) {
      control.stopped =
        'Salesforce validation could not complete. No compiler diagnosis is available; do not change code based on this failure. Check the platform and validate manually.';
      this.app.repos.compileControl.set(sessionId, control);
      this.app.repos.deploys.update(run.id, {
        status: 'failed',
        failures: [
          { componentType: null, fullName: null, fileName: null, problem: (e as Error).message, problemType: 'Error', lineNumber: null, columnNumber: null },
        ],
        completedAt: new Date().toISOString(),
      });
      throw e;
    }
    const ok =
      outcome.ok &&
      !outcome.failures.length &&
      (outcome.codeCoverage === null || !hasApex || outcome.codeCoverage >= rules.minCodeCoverage || testLevel === 'NoTestRun');
    if (outcome.ok && hasApex && outcome.codeCoverage !== null && outcome.codeCoverage < rules.minCodeCoverage && testLevel !== 'NoTestRun') {
      outcome.failures.push({
        componentType: 'CodeCoverage',
        fullName: null,
        fileName: null,
        problem: `Code coverage ${outcome.codeCoverage}% is below the policy minimum of ${rules.minCodeCoverage}%.`,
        problemType: 'Coverage',
        lineNumber: null,
        columnNumber: null,
      });
    }
    const updated = this.app.repos.deploys.update(run.id, {
      status: ok ? 'succeeded' : 'failed',
      sfDeployId: outcome.sfDeployId,
      componentsTotal: outcome.componentsTotal,
      componentsFailed: outcome.componentsFailed,
      testsTotal: outcome.testsTotal,
      testsFailed: outcome.testsFailed,
      codeCoverage: outcome.codeCoverage,
      failures: outcome.failures,
      completedAt: new Date().toISOString(),
    })!;
    // What passed validation, recorded now: a later deploy of anything else is not what was checked.
    const kind = classifyFailure(outcome);
    const infrastructureFailure = !ok && ['platform', 'auth', 'quota', 'transport', 'unknown', 'cancelled'].includes(kind);
    const next = infrastructureFailure
      ? {
          ...control,
          checks: control.checks + 1,
          stopped: `Salesforce ${kind} failure. No code repair is indicated; inspect the archived attempts and validate manually before resuming.`,
        }
      : applyCompileResult(control, files, outcome.failures, ok, hash, scope === 'full');
    next.repairKeys = repairComponents(next.roots, allFiles);
    if (!ok && (!next.roots.length || outcome.failures.some((f) => /UNKNOWN_EXCEPTION/i.test(f.problem))))
      next.stopped =
        'Salesforce returned a platform or test-level failure without component diagnostics. Stop code generation and inspect the validation result before retrying.';
    this.app.repos.compileControl.set(sessionId, next);
    const roots = rootDiagnostics(outcome.failures).length;
    this.app.repos.harness.finish(sessionId, checkpoint.id, ok ? 'succeeded' : 'failed', infrastructureFailure ? null : roots);
    const previous = this.app.repos.harness.previous(sessionId, checkpoint.comparisonKey, checkpoint.id);
    if (!ok && kind === 'component' && previous?.rootCount !== null && previous?.rootCount !== undefined && roots > previous.rootCount) {
      const restored = {
        ...previous.control,
        stopped: `Compile regressed from ${previous.rootCount} to ${roots} root errors. Restored workspace checkpoint ${previous.id}; failed candidate ${checkpoint.id} is quarantined. Validate manually before resuming.`,
        checks: next.checks,
        noProgress: next.noProgress,
      };
      this.app.repos.harness.restore(sessionId, checkpoint.id, previous, restored);
      for (const file of previous.workspace)
        this.bus.emit(sessionId, { type: 'workspace.file', path: file.path, action: 'modified', metadataType: file.metadataType, fullName: file.fullName });
      for (const file of allFiles.filter((f) => !previous.workspace.some((p) => p.path === f.path)))
        this.bus.emit(sessionId, { type: 'workspace.file', path: file.path, action: 'deleted', metadataType: file.metadataType, fullName: file.fullName });
      this.bus.emit(sessionId, { type: 'session.error', agentId: null, message: restored.stopped, recoverable: true });
    }
    if (ok && scope === 'full') this.validatedFingerprints.set(sessionId, workspaceFingerprint(files));
    else this.validatedFingerprints.delete(sessionId);
    this.bus.emit(sessionId, {
      type: 'deploy.validation',
      scope,
      deployId: run.id,
      ok,
      attempt: run.attempt,
      componentsTotal: outcome.componentsTotal,
      componentsFailed: outcome.componentsFailed,
      testsTotal: outcome.testsTotal,
      testsFailed: outcome.testsFailed,
      codeCoverage: outcome.codeCoverage,
      failures: outcome.failures,
    });
    if (this.active.has(sessionId)) this.bus.emit(sessionId, { type: 'session.status', status: 'running', message: null });
    return updated;
  }

  /** True when the latest validation succeeded and the workspace has not changed since. */
  readyToDeploy(sessionId: string): { ok: boolean; reason?: string; validation?: DeployRun } {
    if (this.app.repos.compileControl.get(sessionId).stopped) return { ok: false, reason: this.app.repos.compileControl.get(sessionId).stopped! };
    const last = this.app.repos.deploys.latest(sessionId, true);
    if (!last) return { ok: false, reason: 'No validation has been run yet.' };
    if (last.scope === 'slice')
      return { ok: false, reason: 'The latest check compiled only a slice. Validate the full workspace with tests before deployment.', validation: last };
    if (last.status !== 'succeeded')
      return { ok: false, reason: `Latest validation (attempt ${last.attempt}) failed with ${last.failures.length} problem(s).`, validation: last };
    if (this.workspaceDirty(sessionId)) return { ok: false, reason: 'The workspace changed after the last validation. Validate again.', validation: last };
    const files = this.app.repos.workspace.list(sessionId);
    if (!files.length) return { ok: false, reason: 'Workspace is empty.' };
    // A reviewer's FAIL on this exact workspace blocks the human path as well as the agent's.
    const review = this.latestReviewVerdict(sessionId);
    if (review?.current && review.verdict === 'FAIL')
      return { ok: false, reason: 'The reviewer failed this workspace (VERDICT: FAIL). Address the blockers and review again.', validation: last };
    return { ok: true, validation: last };
  }

  /** Called by the request_deploy tool: creates a confirmation and waits for the user. */
  async requestDeploy(sessionId: string, summary: string, impact: string): Promise<{ text: string; output?: unknown; ok?: boolean }> {
    if (!impact || impact.trim().length < 10) return { text: IMPACT_REQUIRED_MESSAGE, ok: false };
    const ready = this.readyToDeploy(sessionId);
    if (!ready.ok) return { text: `Cannot request deploy: ${ready.reason}`, ok: false };
    // The reviewer is a gate, not advice: a non-trivial workspace needs a verdict for exactly the
    // files staged now, and that verdict must not be FAIL.
    if (this.reviewRequired(sessionId)) {
      const review = this.latestReviewVerdict(sessionId);
      if (!review?.current || !review.verdict)
        return {
          text: 'Cannot request deploy: no reviewer verdict exists for the workspace as it is staged now. Run a "reviewer" sub-agent on the current files (it must end with a VERDICT line), address blockers, then request the deploy.',
          ok: false,
        };
      if (review.verdict === 'FAIL')
        return {
          text: 'Cannot request deploy: the reviewer returned VERDICT: FAIL for this workspace. Address the blockers, re-validate and review again.',
          ok: false,
        };
    }
    const session = this.app.repos.sessions.byId(sessionId)!;
    const org = this.app.repos.orgs.byId(session.orgId)!;
    const files = this.app.repos.workspace.list(sessionId);
    // Every component in the deploy is a subject: a rule scoped to one type must not wave the rest through.
    const decision = this.app.policy.checkCommand(this.app.policy.effective(session.clientId), 'deploy', deploySubjects(files));
    if (decision.effect !== 'allow') {
      this.bus.emit(sessionId, {
        type: 'policy.blocked',
        agentId: 'orchestrator',
        tool: 'deploy',
        rule: decision.effect === 'deny' ? 'impactDenyList' : 'impactAllowList',
        message: permissionBlockedMessage('deploy', decision),
      });
      return { text: `${permissionRefusalText('deploy', decision)} Leave the change staged and validated and tell the user.`, ok: false };
    }
    const details = {
      org: { label: org.label, kind: org.kind, protected: org.protected },
      validation: {
        attempt: ready.validation!.attempt,
        componentsTotal: ready.validation!.componentsTotal,
        testsTotal: ready.validation!.testsTotal,
        codeCoverage: ready.validation!.codeCoverage,
      },
      files: files.map((f) => ({ path: f.path, action: f.action, metadataType: f.metadataType, fullName: f.fullName })),
    };
    const approvedFingerprint = workspaceFingerprint(files);
    const answer = await this.askConfirmation(
      sessionId,
      'deploy',
      `Deploy ${files.length} change${files.length === 1 ? '' : 's'} to ${org.label}${org.kind === 'production' ? ' (PRODUCTION)' : ''}?`,
      summary,
      details,
      [
        { id: 'deploy', label: `Deploy to ${org.label}`, style: org.kind === 'production' ? 'danger' : 'primary' },
        { id: 'cancel', label: 'Not now', style: 'secondary' },
      ],
      undefined,
      impact,
      // Recorded on the confirmation, so what the user approved is compared against the workspace
      // at the moment the deploy actually runs — including after a restart, when the confirmation
      // is answered through `confirm` rather than by the waiting turn.
      approvedFingerprint,
    );
    if (answer.optionId !== 'deploy')
      return { text: 'The user declined the deploy. Ask what they would like to change, or finish with documentation.', output: { declined: true }, ok: true };
    let result: { ok: boolean; message: string; deployId: string; verification?: string };
    try {
      result = await this.executeDeploy(sessionId, answer.byUserId ?? session.userId, { confirmationId: answer.confirmationId, approvedFingerprint });
    } catch (e) {
      // Drift and permission refusals are answers for the user, not crashes: hand them to the agent.
      if (e instanceof HttpError) return { text: `DEPLOY REFUSED: ${e.message}`, output: { refused: true, code: e.code }, ok: false };
      throw e;
    }
    const verification = result.verification ? `\n${result.verification}` : '';
    return {
      text: (result.ok ? `DEPLOY SUCCEEDED: ${result.message}` : `DEPLOY FAILED: ${result.message}`) + verification,
      output: result,
      ok: result.ok,
    };
  }

  /**
   * The real deploy. Every caller — the agent's request_deploy, the panel's Deploy button, an
   * orphaned confirmation answered after a restart — goes through the permission rules here, so a
   * deny rule stops the human as well as the agent. `alwaysConfirmDeploy` is honoured by requiring
   * proof of a confirmation: the id of the answered confirmation card, or `confirmedBy` from a
   * route whose own UI asked the user (the panel's Deploy button after its confirm dialog).
   *
   * `approvedFingerprint` is the workspace as it stood on the confirmation the user answered. The
   * agent path and an orphaned confirmation both have it; the panel's Deploy button does not, and
   * falls back to the fingerprint taken when the validation passed.
   */
  async executeDeploy(
    sessionId: string,
    userId: string,
    opts: { confirmationId?: string; confirmedBy?: string; approvedFingerprint?: WorkspaceFingerprint | null } = {},
  ): Promise<{ ok: boolean; message: string; deployId: string; verification?: string }> {
    const session = this.app.repos.sessions.byId(sessionId)!;
    return this.orgCommand(session.orgId, async () => {
      this.compiling.add(sessionId);
      try {
        return await this.executeDeployLocked(sessionId, userId, opts);
      } finally {
        this.compiling.delete(sessionId);
      }
    });
  }

  private async executeDeployLocked(
    sessionId: string,
    userId: string,
    opts: { confirmationId?: string; confirmedBy?: string; approvedFingerprint?: WorkspaceFingerprint | null },
  ): Promise<{ ok: boolean; message: string; deployId: string; verification?: string }> {
    const target = this.app.repos.sessions.byId(sessionId)!;
    if (this.app.repos.harness.active(target.orgId)) throw conflict('An unresolved org operation must be reconciled before deployment.');
    const ready = this.readyToDeploy(sessionId);
    if (!ready.ok) throw new HttpError(409, 'NOT_VALIDATED', ready.reason!);
    const session = this.app.repos.sessions.byId(sessionId)!;
    const org = this.app.repos.orgs.byId(session.orgId)!;
    const files = this.app.repos.workspace.list(sessionId);
    const rules = this.app.policy.effective(session.clientId);
    const decision = this.app.policy.checkCommand(rules, 'deploy', deploySubjects(files));
    if (decision.effect !== 'allow') {
      this.bus.emit(sessionId, {
        type: 'policy.blocked',
        agentId: 'orchestrator',
        tool: 'deploy',
        rule: decision.effect === 'deny' ? 'impactDenyList' : 'impactAllowList',
        message: permissionBlockedMessage('deploy', decision),
      });
      throw new HttpError(403, 'POLICY', permissionBlockedMessage('deploy', decision));
    }
    if (rules.alwaysConfirmDeploy && !this.confirmedFor(sessionId, 'deploy', opts))
      throw new HttpError(
        409,
        'CONFIRMATION_REQUIRED',
        'Policy requires an explicit confirmation before every deploy. Confirm the deploy card, or send confirmedBy from a UI that asked the user.',
      );
    const drift = this.workspaceDrift(sessionId, files, opts.approvedFingerprint);
    if (drift) {
      this.bus.emit(sessionId, { type: 'session.error', agentId: null, message: drift, recoverable: true });
      throw new HttpError(409, 'WORKSPACE_DRIFT', drift);
    }
    const deleted = files
      .filter((f) => f.action === 'deleted' && f.path.startsWith('__destructive__/'))
      .map((f) => ({ type: f.metadataType!, fullName: f.fullName! }));
    const sourceFiles = files.filter((f) => f.action !== 'deleted').map((f) => ({ path: f.path, content: f.content }));
    const run = this.app.repos.deploys.create({
      sessionId,
      orgId: org.id,
      checkOnly: false,
      testLevel: ready.validation!.testLevel,
      attempt: this.app.repos.deploys.nextAttempt(sessionId),
    });
    this.app.repos.deploys.update(run.id, { status: 'in_progress' });
    this.app.repos.audit.log({
      userId,
      action: 'deploy.start',
      target: sessionId,
      details: { orgId: org.id, files: sourceFiles.length, deleted: deleted.length },
    });
    const runTests =
      ready.validation!.testLevel === 'RunSpecifiedTests'
        ? files.filter((f) => f.metadataType === 'ApexClass' && /@IsTest/i.test(f.content)).map((f) => f.fullName!)
        : [];
    const checkpoint = this.app.repos.harness.create({
      sessionId,
      orgId: org.id,
      deployId: run.id,
      engine: 'metadata',
      scope: 'full',
      checkOnly: false,
      comparisonKey: `deployment:${run.id}`,
      workspace: files,
      control: this.app.repos.compileControl.get(sessionId),
      payload: {
        apiVersion: org.apiVersion,
        files: sourceFiles,
        deleted,
        testLevel: ready.validation!.testLevel,
        runTests,
        zipBase64: this.app.sf.prepareDeploy ? await this.app.sf.prepareDeploy(org.id, sourceFiles, deleted) : undefined,
      },
    });
    let outcome: DeployOutcome;
    try {
      outcome = await executeCheckpoint(this.app, checkpoint, {
        progress: (m) => this.bus.emit(sessionId, { type: 'session.status', status: 'running', message: `Deploying: ${m}` }),
      });
    } catch (e) {
      this.app.repos.harness.invalidate(org.id);
      this.app.repos.deploys.update(run.id, {
        status: 'failed',
        failures: [
          { componentType: null, fullName: null, fileName: null, problem: (e as Error).message, problemType: 'Error', lineNumber: null, columnNumber: null },
        ],
        completedAt: new Date().toISOString(),
      });
      this.bus.emit(sessionId, { type: 'deploy.result', deployId: run.id, ok: false, sfDeployId: null, componentsDeployed: 0, message: (e as Error).message });
      return { ok: false, message: (e as Error).message, deployId: run.id };
    }
    this.app.repos.harness.invalidate(org.id);
    this.app.repos.harness.finish(sessionId, checkpoint.id, outcome.ok ? 'succeeded' : 'failed', rootDiagnostics(outcome.failures).length);
    this.app.repos.deploys.update(run.id, {
      status: outcome.ok ? 'succeeded' : 'failed',
      sfDeployId: outcome.sfDeployId,
      componentsTotal: outcome.componentsTotal,
      componentsFailed: outcome.componentsFailed,
      testsTotal: outcome.testsTotal,
      testsFailed: outcome.testsFailed,
      codeCoverage: outcome.codeCoverage,
      failures: outcome.failures,
      completedAt: new Date().toISOString(),
    });
    const message = outcome.ok
      ? `${outcome.componentsDeployed} component(s) deployed to ${org.label}`
      : `Deploy failed: ${outcome.failures
          .map((f) => f.problem)
          .slice(0, 3)
          .join('; ')}`;
    this.bus.emit(sessionId, {
      type: 'deploy.result',
      deployId: run.id,
      ok: outcome.ok,
      sfDeployId: outcome.sfDeployId,
      componentsDeployed: outcome.componentsDeployed,
      message,
    });
    this.app.repos.audit.log({
      userId,
      action: outcome.ok ? 'deploy.succeeded' : 'deploy.failed',
      target: sessionId,
      details: { sfDeployId: outcome.sfDeployId, orgId: org.id },
    });
    void this.refreshLimits(sessionId).catch(() => null);
    const verification = outcome.ok ? await this.verifyDeploy(sessionId, run.id, org, files) : undefined;
    return { ok: outcome.ok, message, deployId: run.id, verification };
  }

  /**
   * What the user approved and what was validated must be what ships. Compares the workspace as it
   * is right now against the fingerprint taken when the validation succeeded and the one recorded
   * on the deploy confirmation. Returns the refusal message, or null when nothing moved.
   */
  private workspaceDrift(
    sessionId: string,
    files: readonly { path: string; content: string; action: string }[],
    approved?: WorkspaceFingerprint | null,
  ): string | null {
    const now = workspaceFingerprint(files);
    const baselines: { label: string; fingerprint: WorkspaceFingerprint }[] = [];
    const validated = this.validatedFingerprints.get(sessionId);
    if (validated) baselines.push({ label: 'validated', fingerprint: validated });
    if (approved) baselines.push({ label: 'approved', fingerprint: approved });
    for (const b of baselines) {
      const changes = fingerprintDrift(b.fingerprint, now);
      if (changes.length)
        return `The staged changes are not the ones that were ${b.label}. These files changed since then: ${changes.join(', ')}. Nothing was deployed. Validate the workspace again and ask for approval before deploying.`;
    }
    return null;
  }

  /**
   * Read each deployed component back from the org. Salesforce accepting a deploy is not proof the
   * component is there, and a consultant telling a customer "it is live" deserves better evidence.
   * Presence and identity only — Salesforce rewrites metadata on retrieve, so an XML diff would be
   * noise. Never turns a successful deploy into a failed one: it reports, it does not judge.
   */
  private async verifyDeploy(
    sessionId: string,
    deployId: string,
    org: OrgRow,
    files: readonly { metadataType: string | null; fullName: string | null; action: string; path: string }[],
  ): Promise<string | undefined> {
    try {
      const wanted = [
        ...new Map(
          files
            .filter((f) => f.action !== 'deleted' && f.metadataType && f.fullName)
            .map((f) => [`${f.metadataType}:${f.fullName}`, { metadataType: f.metadataType!, fullName: f.fullName! }]),
        ).values(),
      ];
      if (!wanted.length) return undefined;
      const components: { metadataType: string; fullName: string; status: 'confirmed' | 'missing' | 'unreadable'; note: string | null }[] = [];
      for (const c of wanted) {
        try {
          const read = await this.app.sf.readComponent(org.id, c.metadataType, c.fullName);
          components.push({ ...c, status: read.length ? 'confirmed' : 'missing', note: null });
        } catch (e) {
          components.push({ ...c, status: 'unreadable', note: (e as Error).message.slice(0, 200) });
        }
      }
      const confirmed = components.filter((c) => c.status === 'confirmed');
      const missing = components.filter((c) => c.status === 'missing');
      const unreadable = components.filter((c) => c.status === 'unreadable');
      const parts: string[] = [];
      if (confirmed.length)
        parts.push(
          confirmed.length === components.length
            ? `Now live in ${org.label}: ${list(confirmed.map((c) => plainComponent(c.metadataType, c.fullName)))}.`
            : `${confirmed.length} of ${components.length} changes are live in ${org.label}: ${list(confirmed.map((c) => plainComponent(c.metadataType, c.fullName)))}.`,
        );
      if (missing.length)
        parts.push(
          `Not found in the org: ${list(missing.map((c) => plainComponent(c.metadataType, c.fullName)))}. Salesforce accepted the deploy, so check the org before telling anyone the change is done.`,
        );
      if (unreadable.length) parts.push(`Could not be checked: ${list(unreadable.map((c) => plainComponent(c.metadataType, c.fullName)))}.`);
      const summary = parts.join(' ');
      this.bus.emit(sessionId, { type: 'deploy.verified', deployId, ok: !missing.length, components, summary });
      return summary;
    } catch (e) {
      this.app.log.warn({ err: e, sessionId, deployId }, 'post-deploy verification failed');
      return undefined;
    }
  }

  /** Proof that a user confirmed this kind of action: an answered confirmation card, or a route vouching for its own dialog. */
  private confirmedFor(sessionId: string, kind: 'deploy' | 'commit', opts: { confirmationId?: string; confirmedBy?: string }): boolean {
    if (opts.confirmedBy) return true;
    if (!opts.confirmationId) return false;
    const c = this.app.repos.confirmations.byId(opts.confirmationId);
    return !!c && c.sessionId === sessionId && c.kind === kind && !!c.resolvedAt && c.resolvedOption === kind;
  }

  // ------------------------------------------------------------ github
  async requestCommit(sessionId: string, message: string, createPullRequest: boolean): Promise<{ text: string; output?: unknown; ok?: boolean }> {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const repo = this.app.repos.github.byClient(session.clientId);
    if (!repo || !this.app.github.hasToken(session.clientId))
      return { text: 'No GitHub repository (with token) is configured for this client; skip committing and tell the user.', ok: false };
    const files = this.app.repos.workspace.list(sessionId);
    const docs = this.app.repos.docs.bySession(sessionId).filter((d) => !d.committedSha);
    if (!files.length && !docs.length) return { text: 'Nothing to commit (no workspace files and no new documentation).', ok: false };
    const branch = session.branchName ?? sessionBranchName(repo, session);
    // Scoping a commit rule to `owner/repo#branch` is how an admin keeps agents off a protected branch.
    const decision = this.app.policy.checkCommand(this.app.policy.effective(session.clientId), 'github_commit', [`${repo.owner}/${repo.repo}#${branch}`]);
    if (decision.effect !== 'allow') return { text: permissionRefusalText('github_commit', decision), ok: false };
    const details = {
      repo: `${repo.owner}/${repo.repo}`,
      branch,
      strategy: repo.commitStrategy,
      createPullRequest: createPullRequest || repo.commitStrategy === 'pull-request',
      files: files.map((f) => ({ path: `${repo.sourceRoot}/${f.path}`, action: f.action })),
      docs: docs.map((d) => d.path),
      message,
    };
    const answer = await this.askConfirmation(sessionId, 'commit', `Commit to ${repo.owner}/${repo.repo} on ${branch}?`, message, details, [
      { id: 'commit', label: 'Commit', style: 'primary' },
      { id: 'cancel', label: 'Not now', style: 'secondary' },
    ]);
    if (answer.optionId !== 'commit') return { text: 'The user declined the commit.', output: { declined: true }, ok: true };
    const r = await this.executeCommit(sessionId, answer.byUserId ?? session.userId, message, createPullRequest, { confirmationId: answer.confirmationId });
    return {
      text: `COMMITTED ${r.sha.slice(0, 7)} on ${r.branch}: ${r.url}${r.pullRequestUrl ? `\nPull request: ${r.pullRequestUrl}` : ''}`,
      output: r,
      ok: true,
    };
  }

  /** The real commit; permission-checked and confirmation-gated like executeDeploy. */
  async executeCommit(
    sessionId: string,
    userId: string,
    message: string,
    createPullRequest: boolean,
    opts: { confirmationId?: string; confirmedBy?: string } = {},
  ): Promise<{ sha: string; url: string; branch: string; filesChanged: number; pullRequestUrl: string | null }> {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const user = this.app.repos.users.byId(userId) ?? this.app.repos.users.byId(session.userId)!;
    const repo = this.app.github.repoFor(session.clientId);
    const branch = session.branchName ?? sessionBranchName(repo, session);
    // Same rules for the panel's Commit button as for the agent: a deny rule must stop the human too.
    const decision = this.app.policy.checkCommand(this.app.policy.effective(session.clientId), 'github_commit', [`${repo.owner}/${repo.repo}#${branch}`]);
    if (decision.effect !== 'allow') {
      this.bus.emit(sessionId, {
        type: 'policy.blocked',
        agentId: 'orchestrator',
        tool: 'github_commit',
        rule: decision.effect === 'deny' ? 'impactDenyList' : 'impactAllowList',
        message: permissionBlockedMessage('github_commit', decision),
      });
      throw new HttpError(403, 'POLICY', permissionBlockedMessage('github_commit', decision));
    }
    if (!this.confirmedFor(sessionId, 'commit', opts))
      throw new HttpError(
        409,
        'CONFIRMATION_REQUIRED',
        'A commit needs an explicit confirmation. Confirm the commit card, or send confirmedBy from a UI that asked the user.',
      );
    const files = this.app.repos.workspace.list(sessionId);
    const docs = this.app.repos.docs.bySession(sessionId).filter((d) => !d.committedSha);
    const commitFiles = [
      ...files
        .filter((f) => !f.path.startsWith('__destructive__/'))
        .map((f) => ({ path: `${repo.sourceRoot}/${f.path}`, content: f.action === 'deleted' ? null : f.content })),
      // A staged deletion of an org component (delete_component) is recorded under a synthetic
      // __destructive__/Type/FullName marker path, not the file's real location in the repo.
      // Committing the marker path would leave the actual component file behind, so this resolves
      // the real SFDX source path for {metadataType, fullName} and deletes that instead.
      ...files
        .filter((f) => f.path.startsWith('__destructive__/') && f.metadataType && f.fullName)
        .map((f) => ({ path: `${repo.sourceRoot}/${sourcePathFor(f.metadataType!, f.fullName!)}`, content: null })),
      ...docs.map((d) => ({ path: d.path, content: d.markdown })),
    ];
    const fullMessage = `${message.trim()}\n\nSession: ${session.id}\nOrg: ${this.app.repos.orgs.byId(session.orgId)?.label}\nAuthored with SF Claws by ${user.displayName}`;
    const r = await this.app.github.commit(session.clientId, branch, commitFiles, fullMessage, { name: user.displayName, email: user.email });
    for (const d of docs) this.app.repos.docs.setCommitted(d.id, r.sha);
    this.app.repos.sessions.update(sessionId, { branchName: branch });
    let pullRequestUrl: string | null = null;
    if ((createPullRequest || repo.commitStrategy === 'pull-request') && branch !== repo.defaultBranch) {
      try {
        const pr = await this.app.github.openPullRequest(
          session.clientId,
          branch,
          message.split('\n')[0].slice(0, 100),
          `${docs[0]?.summary ?? message}\n\n_Created by SF Claws session ${session.id}_`,
        );
        pullRequestUrl = pr.url;
      } catch (e) {
        this.app.log.warn({ err: e }, 'PR creation failed');
      }
    }
    this.bus.emit(sessionId, {
      type: 'github.commit',
      owner: repo.owner,
      repo: repo.repo,
      branch,
      sha: r.sha,
      url: r.url,
      filesChanged: r.filesChanged,
      message: message.split('\n')[0],
      pullRequestUrl,
    });
    this.app.repos.audit.log({ userId, action: 'github.commit', target: sessionId, details: { sha: r.sha, branch } });
    return { ...r, branch, pullRequestUrl };
  }

  // ------------------------------------------------------------ docs
  async writeDoc(sessionId: string, input: { title: string; summary: string; technical: string; endUser: string; tags?: string[] }): Promise<DocEntry> {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const org = this.app.repos.orgs.byId(session.orgId)!;
    const client = this.app.repos.clients.byId(session.clientId)!;
    const user = this.app.repos.users.byId(session.userId);
    const repo = this.app.repos.github.byClient(session.clientId);
    const date = new Date().toISOString();
    const slug =
      input.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'session';
    const seq = this.app.repos.docs.bySession(sessionId).length + 1;
    const path = `${repo?.docsRoot ?? 'docs/harness'}/${orgSlug(org)}/${date.slice(0, 10)}-${slug}${seq > 1 ? `-${seq}` : ''}.md`;
    const deploys = this.app.repos.deploys.list(sessionId);
    const markdown = `---
title: ${yamlStr(input.title)}
client: ${yamlStr(client.name)}
org: ${yamlStr(org.label)} (${org.kind})
session: ${session.id}
author: ${yamlStr(user?.displayName ?? 'unknown')}
date: ${date}
tags: [${(input.tags ?? []).map(yamlStr).join(', ')}]
---

# ${input.title}

> ${input.summary.trim()}

## Technical documentation

${input.technical.trim()}

## End-user documentation

${input.endUser.trim()}

## Session record

- Validations: ${
      deploys
        .filter((d) => d.checkOnly)
        .map((d) => `attempt ${d.attempt} ${d.status}`)
        .join(', ') || 'none'
    }
- Deploys: ${
      deploys
        .filter((d) => !d.checkOnly)
        .map((d) => `${d.status}${d.sfDeployId ? ` (${d.sfDeployId})` : ''}`)
        .join(', ') || 'none'
    }
- Staged files: ${
      this.app.repos.workspace
        .list(sessionId)
        .map((f) => `\`${f.path}\` (${f.action})`)
        .join(', ') || 'none'
    }
- Tokens: ${session.inputTokens + session.cachedInputTokens} in / ${session.outputTokens} out (≈ $${session.costUsd.toFixed(4)})

_Generated by SF Claws_
`;
    const doc = this.app.repos.docs.create({
      sessionId,
      clientId: client.id,
      orgId: org.id,
      path,
      title: input.title,
      markdown,
      summary: input.summary.trim(),
      tags: input.tags ?? [],
      committedSha: null,
    });
    this.bus.emit(sessionId, { type: 'doc.written', docId: doc.id, path: doc.path, title: doc.title });
    return doc;
  }

  // ------------------------------------------------------------ limits
  async refreshLimits(sessionId: string): Promise<OrgLimits> {
    const session = this.app.repos.sessions.byId(sessionId)!;
    const rules = this.app.policy.effective(session.clientId);
    const limits = await this.app.sf.limits(session.orgId, rules.apiLimitWarnPercent);
    this.bus.emit(sessionId, { type: 'org.limits', limits });
    return limits;
  }

  // ------------------------------------------------------------ recovery
  /** Everything a client needs to cache a session locally and recover it later. */
  snapshot(sessionId: string): SessionSnapshot {
    const session = this.app.repos.sessions.byId(sessionId);
    if (!session) throw notFound('Session');
    return {
      session,
      events: this.app.repos.events.listAfter(sessionId, 0, 20_000),
      todos: this.app.repos.todos.get(sessionId),
      notes: this.app.repos.notes.list(sessionId),
      workspace: this.app.repos.workspace.list(sessionId),
      deploys: this.app.repos.deploys.list(sessionId),
      docs: this.app.repos.docs.bySession(sessionId),
      pendingConfirmations: this.app.repos.confirmations.pending(sessionId).map((c) => ({ id: c.id, kind: c.kind, title: c.title, ...c.payload })),
      lastSeq: this.app.repos.events.lastSeq(sessionId),
      running: this.isRunning(sessionId),
      snapshotAt: new Date().toISOString(),
    };
  }

  /** Restart a dead/interrupted session. The orchestrator has its persisted conversation, todo list, notes and workspace. */
  resume(sessionId: string, userId: string): void {
    const session = this.app.repos.sessions.byId(sessionId);
    if (!session) throw notFound('Session');
    if (this.active.has(sessionId)) throw conflict('Session is already running');
    const compileStop = this.app.repos.compileControl.get(sessionId).stopped;
    if (compileStop)
      throw conflict(
        `${compileStop} Open Changes, inspect the failed validation, make only evidence-backed manual repairs if needed, and run a full validation before resuming.`,
      );
    const todos = this.app.repos.todos.get(sessionId);
    const open = todos.filter((t) => t.status !== 'completed');
    const notes = this.app.repos.notes.list(sessionId);
    const msg = [
      '[Harness recovery] The previous run of this session was interrupted (server restart, crash or cancellation). Continue the work from where it stopped.',
      open.length
        ? `Open todo items:\n${open.map((t) => `- [${t.status}] ${t.content}`).join('\n')}`
        : 'The todo list has no open items; verify the last step actually completed (check workspace, validations, deploys, docs) and finish or report.',
      notes.length ? `Scratchpad notes available: ${notes.map((n) => n.title).join(', ')} (use scratchpad_read).` : '',
      'Re-validate before any deploy; do not assume earlier validations are still current.',
    ]
      .filter(Boolean)
      .join('\n\n');
    this.startTurn(sessionId, userId, msg);
  }

  /**
   * Permission rules + approval gate for every command that impacts Salesforce data or metadata.
   * The user sees WHY (the agent's reason) and WHAT (the exact command) before it runs. Returns
   * null when allowed, or the refusal message to hand back to the agent.
   *
   * `subjects` is what the command acts on — the sObject, the components, the branch. Rules can be
   * scoped to them (`update_record(Account)`), so passing them is what makes the scoping real.
   */
  async gate(req: {
    sessionId: string;
    agentId: string;
    command: ImpactCommand;
    reason: string;
    /** Blast radius: who and what this affects, in language a business admin can judge. */
    impact: string;
    input: unknown;
    title: string;
    subjects?: string[];
  }): Promise<string | null> {
    const { sessionId, agentId, command, reason, impact, input, title } = req;
    const session = this.app.repos.sessions.byId(sessionId)!;
    const rules = this.app.policy.effective(session.clientId);
    const decision = this.app.policy.checkCommand(rules, command, req.subjects ?? []);
    if (decision.effect !== 'allow') {
      this.bus.emit(sessionId, {
        type: 'policy.blocked',
        agentId,
        tool: command,
        rule: decision.effect === 'deny' ? 'impactDenyList' : 'impactAllowList',
        message: permissionBlockedMessage(command, decision),
      });
      return permissionRefusalText(command, decision);
    }
    // The reason is owed whether or not a grant exists: it is what the audit trail and the card
    // show, and a granted command with no reason is a command nobody can explain afterwards.
    if (!reason || reason.trim().length < 10)
      return 'REFUSED: provide a clear "reason" (why this command is needed, in plain language for the user) and try again.';
    if (!impact || impact.trim().length < 10) return IMPACT_REQUIRED_MESSAGE;
    // A session grant skips the prompt, never the rules above — which is why it is checked after
    // them. Grants are stored as permission rules scoped to the subjects that were approved
    // (`run_apex_tests(FooTest)`), so every subject of this call must be covered: "allow for this
    // session" on one test class does not cover a different one.
    const subjects = req.subjects ?? [];
    const granted = this.app.repos.permissions.list(sessionId).map((g) => g.command);
    if (granted.length && this.app.policy.checkCommand({ ...rules, impactAllowList: granted, impactDenyList: [] }, command, subjects).effect === 'allow')
      return null;
    const sessionAllowable =
      this.app.policy.checkCommand({ ...rules, impactAllowList: rules.sessionAllowable, impactDenyList: [] }, command, subjects).effect === 'allow';
    const options = [
      { id: 'approve', label: 'Allow once', style: 'primary' as const },
      ...(sessionAllowable ? [{ id: 'approve_session', label: 'Allow for this session', style: 'secondary' as const }] : []),
      { id: 'deny', label: 'Deny', style: 'danger' as const },
    ];
    const answer = await this.askConfirmation(
      sessionId,
      'command',
      title,
      reason,
      { command: { name: command, input, sessionAllowable }, agentId, impact },
      options,
      { name: command, input, sessionAllowable },
      impact,
    );
    if (answer.optionId === 'approve_session') {
      const by = answer.byUserId ?? session.userId;
      if (subjects.length) for (const subject of subjects) this.app.repos.permissions.grant(sessionId, `${command}(${subject})`, by);
      else this.app.repos.permissions.grant(sessionId, command, by);
      return null;
    }
    if (answer.optionId === 'approve') return null;
    return 'The user DENIED this command. Do not retry it; ask the user how to proceed or choose a different approach.';
  }

  /**
   * Reminders to append to a tool result. Standing prompt rules fade over a long run; a nudge at
   * the moment it matters lands, and costs nothing when nothing is wrong.
   */
  remindersFor(ctx: ToolContext, tool: string): string[] {
    const sessionId = ctx.session.id;
    const turn = this.active.get(sessionId);
    const todos = this.app.repos.todos.get(sessionId);
    const limits = this.app.repos.limits.get(ctx.org.id);
    const warnings = (limits?.warnings ?? []).slice(0, 2).join('; ');
    // Once per threshold crossing: the same warning on every call is noise the model tunes out.
    let orgLimitWarning: string | null = null;
    if (turn && warnings && warnings !== turn.orgLimitWarned) {
      turn.orgLimitWarned = warnings;
      orgLimitWarning = warnings;
    }
    const callsThisRun = (turn?.agentCalls.get(ctx.agent.id) ?? 0) + 1;
    turn?.agentCalls.set(ctx.agent.id, callsThisRun);
    const callsSinceTodoWrite = turn?.callsSinceTodoWrite ?? 0;
    const callsSinceTodoReminder = callsSinceTodoWrite - (turn?.todoRemindedAt ?? 0);
    // The dirty check pages through the event log, so only pay for it on the tools that use it.
    const cares = tool === 'request_deploy' || tool.startsWith('write_') || tool.startsWith('edit_');
    const session = this.app.repos.sessions.byId(sessionId) ?? ctx.session;
    const planMode = ctx.rules.requirePlanApproval;
    const out = buildReminders({
      role: ctx.agent.role,
      tool,
      callsSinceTodoWrite,
      callsSinceTodoReminder,
      workspaceDirtyAfterCleanValidation: cares && this.app.repos.deploys.latest(sessionId, true)?.status === 'succeeded' && this.workspaceDirty(sessionId),
      stagedWithoutDocs: this.app.repos.workspace.list(sessionId).length > 0 && (turn?.docsWritten ?? 0) === 0,
      orgIsProduction: ctx.org.kind === 'production' || ctx.org.protected,
      orgLimitWarning,
      hasOpenTodos: todos.some((t) => t.status === 'pending' || t.status === 'in_progress'),
      planPending: planMode !== 'never' && !session.planApprovedAt,
      callsThisRun,
      budget: turn ? this.budgetThresholdCrossed(sessionId, turn) : null,
    });
    if (turn && out.some((r) => r.includes('since you last updated the todo list'))) turn.todoRemindedAt = callsSinceTodoWrite;
    return out;
  }

  /** The tightest ceiling that crossed a new reminder fraction with the spend so far, once per fraction per turn. */
  private budgetThresholdCrossed(
    sessionId: string,
    turn: ActiveTurn,
  ): { scope: 'turn' | 'session' | 'client_month'; spentUsd: number; limitUsd: number } | null {
    const session = this.app.repos.sessions.byId(sessionId);
    if (!session) return null;
    const rules = this.app.policy.effective(session.clientId);
    const scopes: { scope: 'turn' | 'session' | 'client_month'; limitUsd: number; spentUsd: number }[] = [
      { scope: 'turn', limitUsd: rules.maxTurnCostUsd, spentUsd: turn.costUsd },
      { scope: 'session', limitUsd: rules.maxSessionCostUsd, spentUsd: session.costUsd },
    ];
    if (rules.maxClientMonthlyCostUsd)
      scopes.push({
        scope: 'client_month',
        limitUsd: rules.maxClientMonthlyCostUsd,
        spentUsd: this.app.repos.usage.clientCostSince(session.clientId, monthStartIso()),
      });
    let best: { scope: 'turn' | 'session' | 'client_month'; spentUsd: number; limitUsd: number; fraction: number } | null = null;
    for (const s of scopes) {
      if (!s.limitUsd || s.limitUsd <= 0) continue;
      const ratio = s.spentUsd / s.limitUsd;
      for (const fraction of BUDGET_REMINDER_FRACTIONS) {
        const key = `${s.scope}:${fraction}`;
        if (ratio >= fraction && !turn.budgetRemindedAt.has(key)) {
          turn.budgetRemindedAt.add(key);
          if (!best || fraction > best.fraction) best = { ...s, fraction };
        }
      }
    }
    return best ? { scope: best.scope, spentUsd: best.spentUsd, limitUsd: best.limitUsd } : null;
  }

  // ------------------------------------------------------------ budget
  /** Record spend against the current turn (the per-turn ceiling reads this). */
  addTurnCost(sessionId: string, costUsd: number): void {
    const turn = this.active.get(sessionId);
    if (turn) turn.costUsd += costUsd;
  }

  /**
   * The ceiling this call would cross, or null when within budget. Checked before every model call
   * — after the fact only reports money already spent. The doc_writer may spend into the reserve so
   * a stopped run still gets documented.
   */
  checkBudget(sessionId: string, role: AgentRole, projectedUsd = 0): CostCeilingError | null {
    const session = this.app.repos.sessions.byId(sessionId);
    if (!session) return null;
    const rules = this.app.policy.effective(session.clientId);
    if (!rules.maxTurnCostUsd && !rules.maxSessionCostUsd && !rules.maxClientMonthlyCostUsd) return null;
    return checkCostCeilings({
      rules,
      turnCostUsd: this.active.get(sessionId)?.costUsd ?? 0,
      sessionCostUsd: session.costUsd,
      clientMonthCostUsd: this.app.repos.usage.clientCostSince(session.clientId, monthStartIso()),
      documenting: role === 'doc_writer',
      projectedUsd,
    });
  }

  /**
   * Called by the orchestrator's loop once per turn with its context usage. Warns the user while
   * there is still time to act: a session that dies at `context_exhausted` mid-build is a session
   * whose work has to be reconstructed. Each level is announced once per session — a warning
   * repeated every turn is a warning nobody reads.
   */
  noteContextPressure(sessionId: string, usedTokens: number, limitTokens: number): void {
    if (!limitTokens) return;
    const percent = Math.round((usedTokens / limitTokens) * 100);
    const level = percent >= CONTEXT_CRITICAL_PERCENT ? 'critical' : percent >= CONTEXT_WARNING_PERCENT ? 'warning' : null;
    if (!level) return;
    const seen = this.contextWarned.get(sessionId) ?? new Set<'warning' | 'critical'>();
    if (seen.has(level)) return;
    seen.add(level);
    if (level === 'critical') seen.add('warning');
    this.contextWarned.set(sessionId, seen);
    this.bus.emit(sessionId, {
      type: 'session.context',
      usedTokens,
      limitTokens,
      percent,
      level,
      message:
        level === 'critical'
          ? `This session is nearly out of room: the conversation is using about ${percent}% of what the model can hold, and the next message is likely to be refused. Compact the session now, or start a new one and say what you still need.`
          : `This session is getting long: the conversation is using about ${percent}% of what the model can hold. It will keep working for now, but it will stop before much longer. You can compact it, or start a new session for the next piece of work.`,
    });
  }

  /**
   * Compact the orchestrator conversation on demand (the user pressing "Compact"). Uses the same
   * two-stage path the loop uses automatically; refused while a turn is running, because the
   * conversation is being written to.
   */
  async compactSession(sessionId: string): Promise<{ ok: boolean; beforeTokens: number; afterTokens: number }> {
    const session = this.app.repos.sessions.byId(sessionId);
    if (!session) throw notFound('Session');
    if (this.active.has(sessionId)) throw conflict('Session is running. Wait for the turn to finish, or cancel it, then compact.');
    const turn: ActiveTurn = {
      abort: new AbortController(),
      promise: Promise.resolve(),
      originals: new Map(),
      docsWritten: 0,
      toolCalls: 0,
      costUsd: 0,
      callsSinceTodoWrite: 0,
      awaitingUser: false,
      unsubscribers: [],
      blocking: new Set(),
      orgLimitWarned: null,
      todoRemindedAt: 0,
      agentCalls: new Map(),
      budgetRemindedAt: new Set(),
    };
    const ctx = this.toolContext(sessionId, { id: 'orchestrator', role: 'orchestrator', parentId: null }, turn);
    const resolved = this.app.ai.resolve('orchestrator', ctx.session.userId);
    const prompt = await this.systemPrompt('orchestrator', ctx);
    const agent = new AgentRun(
      {
        agentId: 'orchestrator',
        parentId: null,
        role: 'orchestrator',
        model: resolved.model,
        provider: resolved.provider,
        effort: resolved.effort,
        maxIterations: resolved.maxIterations,
        system: prompt.system,
        promptSections: prompt.sections,
        tools: toolsForRole('orchestrator'),
        persistent: true,
        fallback: resolved.fallback,
      },
      ctx,
    );
    try {
      const r = await agent.compactOnDemand();
      // The conversation shrank, so the earlier warnings no longer describe it.
      this.contextWarned.delete(sessionId);
      this.bus.emit(sessionId, {
        type: 'session.status',
        status: this.app.repos.sessions.byId(sessionId)!.status,
        message: r.ok ? 'Conversation compacted — the session has room again.' : 'Nothing to compact yet.',
      });
      return r;
    } finally {
      turn.abort.abort(); // releases the bus subscription toolContext registered
    }
  }

  /**
   * Sessions the consultant never closed. The consultant decides when work is done, so nothing is
   * marked completed here — a session with open todos that nobody has touched for a long time is
   * spun down to `cancelled`, which is terminal, honest and still resumable.
   */
  startIdleSweep(): void {
    if (this.idleSweep) return;
    this.idleSweep = setInterval(() => this.sweepIdleSessions(), IDLE_SWEEP_INTERVAL_MS);
    this.idleSweep.unref?.();
  }
  stopIdleSweep(): void {
    if (this.idleSweep) clearInterval(this.idleSweep);
    this.idleSweep = null;
  }

  sweepIdleSessions(now = Date.now()): number {
    let spun = 0;
    for (const status of ['idle', 'awaiting_confirmation', 'awaiting_plan'] as const) {
      for (const s of this.app.repos.sessions.list({ status, limit: 1000 })) {
        if (this.active.has(s.id)) continue;
        const last = Date.parse(s.updatedAt ?? s.createdAt);
        if (!Number.isFinite(last) || now - last < IDLE_SPIN_DOWN_MS) continue;
        const open = this.app.repos.todos.get(s.id).filter((t) => t.status === 'pending' || t.status === 'in_progress');
        if (!open.length) continue;
        this.app.repos.sessions.update(s.id, { status: 'cancelled' });
        this.bus.emit(s.id, {
          type: 'session.status',
          status: 'cancelled',
          message: `Spun down after ${Math.round(IDLE_SPIN_DOWN_MS / 3_600_000)} hours without activity, with ${open.length} item(s) still open. Use "Resume" to pick the work back up.`,
        });
        spun++;
      }
    }
    return spun;
  }

  /** True when the agent asked the user something and is not expected to keep working. */
  isAwaitingUser(sessionId: string): boolean {
    return this.active.get(sessionId)?.awaitingUser ?? false;
  }

  // ------------------------------------------------------------ plan mode
  /**
   * Whether staging tools are allowed yet. Non-trivial work needs an approved plan first: the
   * admin who knows the business process signs off on what will change in Salesforce terms before
   * any XML exists, which is far cheaper than discovering the misunderstanding after a deploy.
   */
  requireApprovedPlan(sessionId: string, tool: string, input: any): string | null {
    const session = this.app.repos.sessions.byId(sessionId);
    if (!session) return null;
    const mode = this.app.policy.effective(session.clientId).requirePlanApproval;
    if (mode === 'never' || session.planApprovedAt) return null;
    // Delegating to a role that only reads is investigation, not a change: allowed while
    // planning in every mode. Planning well depends on it.
    if (this.isReadOnlyDelegation(sessionId, tool, input)) return null;
    if (mode !== 'always' && !this.isNonTrivial(sessionId, tool, input)) return null;
    return PLAN_REQUIRED_MESSAGE;
  }

  private isReadOnlyDelegation(sessionId: string, tool: string, input: any): boolean {
    if (tool === 'run_subagent') return READ_ONLY_SUBAGENT_ROLES.has(String(input?.role) as AgentRole);
    if (tool === 'consult_specialist') {
      const session = this.app.repos.sessions.byId(sessionId);
      const agent = session ? this.app.repos.customAgents.resolve(session.clientId, String(input?.specialist ?? '')) : undefined;
      return !!agent && READ_ONLY_SUBAGENT_ROLES.has(agent.baseRole);
    }
    return false;
  }

  /**
   * Whether this action is big enough to deserve sign-off first. A single fully specified field or
   * layout change should not cost the user a round trip; delegating to a builder, touching code or
   * automation, or spreading across components should.
   */
  private isNonTrivial(sessionId: string, tool: string, input: any): boolean {
    if (tool === 'run_subagent') return BUILDER_ROLES.has(String(input?.role));
    if (tool === 'delete_component') return true;
    const path = normalizePath(String(input?.path ?? ''));
    const inferred = path ? inferComponentFromPath(path) : null;
    const metadataType = String(input?.metadataType ?? inferred?.metadataType ?? '');
    // Code and automation are never a one-liner: they carry tests, versions and runtime behaviour.
    if (PLAN_REQUIRED_TYPES.has(metadataType)) return true;
    const component = String(input?.fullName ?? inferred?.fullName ?? path);
    const staged = this.app.repos.workspace.list(sessionId);
    const distinct = new Set(staged.map((f) => f.fullName ?? f.path));
    if (component) distinct.add(component);
    return distinct.size > 1;
  }

  /** Called by the submit_plan tool: shows the plan and blocks until the user answers. */
  async submitPlan(sessionId: string, summary: string, markdown: string, impact: string): Promise<{ text: string; output?: unknown; ok?: boolean }> {
    if (!impact || impact.trim().length < 10) return { text: IMPACT_REQUIRED_MESSAGE, ok: false };
    const session = this.app.repos.sessions.byId(sessionId)!;
    const revision = (session.planRevision ?? 0) + 1;
    const options = [
      { id: 'approve', label: 'Approve and build', style: 'primary' as const },
      { id: 'changes', label: 'Request changes', style: 'secondary' as const },
    ];
    const c = this.app.repos.confirmations.create({
      sessionId,
      kind: 'plan',
      title: 'Approve this plan?',
      payload: { description: summary, details: { markdown, revision, impact }, options, impact },
    });
    // Both events: confirmation.requested so the panel renders the plan through the one approval
    // path every other gate uses, and plan.submitted as the semantic signal for plan state.
    this.bus.emit(sessionId, {
      type: 'confirmation.requested',
      confirmationId: c.id,
      kind: 'plan',
      title: 'Approve this plan?',
      description: summary,
      details: { markdown, revision, impact },
      options,
      impact,
    });
    this.bus.emit(sessionId, { type: 'plan.submitted', confirmationId: c.id, revision, markdown });
    this.setStatus(sessionId, 'awaiting_plan', summary);
    const { optionId: answer } = await this.waitForConfirmation(sessionId, c.id);
    const note = this.answerTextOf(c.id);
    if (answer === 'approve') {
      this.app.repos.sessions.update(sessionId, { planMarkdown: markdown, planApprovedAt: new Date().toISOString(), planRevision: revision });
      this.bus.emit(sessionId, { type: 'plan.resolved', approved: true, revision, note: note ?? null });
      this.app.repos.audit.log({ userId: session.userId, action: 'plan.approved', target: sessionId, details: { revision } });
      if (revision > 1) this.logPlanRevision(sessionId, `Revision ${revision} APPROVED: ${summary}`);
      return {
        text: 'The user APPROVED the plan. Build exactly what it describes; if you discover it has to change materially, submit a revised plan rather than improvising.',
        output: { approved: true, revision },
      };
    }
    this.app.repos.sessions.update(sessionId, { planRevision: revision });
    this.bus.emit(sessionId, { type: 'plan.resolved', approved: false, revision, note: note ?? null });
    if (answer === 'changes') this.logPlanRevision(sessionId, `Revision ${revision} REJECTED${note ? ` — user said: "${note}"` : ''}. Plan was: ${summary}`);
    if (answer === 'cancel') {
      const turn = this.active.get(sessionId);
      if (turn) turn.awaitingUser = true;
      return { text: 'The plan was dismissed without an answer. Stop and wait for the user.', output: { approved: false }, ok: true };
    }
    return {
      text: `The user asked for CHANGES to the plan${note ? `: "${note}"` : ' (no note given — ask what they want different)'}. You are returning to planning after a request for changes: revision ${revision} was rejected, so do not assume the earlier plan is still relevant. Revise and call submit_plan again.`,
      output: { approved: false, note },
      ok: true,
    };
  }

  // ------------------------------------------------------------ questions
  /**
   * Called by the ask_user tool. A real question with real buttons, rather than the model ending
   * its turn with a question in prose that the harness then has to detect with a regex.
   */
  async askUser(
    sessionId: string,
    question: string,
    options: { id: string; label: string; detail?: string }[],
    allowFreeText: boolean,
    header?: string | null,
  ): Promise<{ text: string; output?: unknown; ok?: boolean }> {
    const clean = (options ?? []).filter((o) => o?.id && o?.label).slice(0, 6);
    const chip = header?.trim() ? header.trim().slice(0, 12) : undefined;
    if (!clean.length) return { text: 'ask_user needs at least one option. Offer concrete choices, not an open-ended question.', ok: false };
    const uiOptions = clean.map((o, i) => ({
      id: o.id,
      label: o.label,
      detail: o.detail,
      style: (i === 0 ? 'primary' : 'secondary') as 'primary' | 'secondary',
    }));
    const c = this.app.repos.confirmations.create({
      sessionId,
      kind: 'question',
      title: question,
      payload: { description: question, details: { allowFreeText, options: uiOptions, header: chip }, options: uiOptions },
    });
    this.bus.emit(sessionId, {
      type: 'confirmation.requested',
      confirmationId: c.id,
      kind: 'question',
      title: question,
      description: question,
      details: { allowFreeText, options: uiOptions, header: chip },
      options: uiOptions,
    });
    this.setStatus(sessionId, 'awaiting_confirmation', question);
    const { optionId: answer } = await this.waitForConfirmation(sessionId, c.id);
    const freeText = this.answerTextOf(c.id);
    if (answer === 'cancel' && !freeText) {
      const turn = this.active.get(sessionId);
      if (turn) turn.awaitingUser = true;
      return { text: 'The user dismissed the question without answering. Stop and wait for them rather than guessing.', output: { answered: false }, ok: true };
    }
    const chosen = clean.find((o) => o.id === answer);
    const text = freeText
      ? `The user answered: "${freeText}"${chosen ? ` (after choosing "${chosen.label}")` : ''}`
      : `The user chose: ${chosen?.label ?? answer}`;
    return { text, output: { optionId: answer, label: chosen?.label, answerText: freeText ?? null } };
  }

  /** The free-text answer a user typed on a confirmation, if any. */
  private answerTextOf(confirmationId: string): string | null {
    const row = this.app.repos.confirmations.byId(confirmationId);
    const t = (row?.payload as { answerText?: string } | undefined)?.answerText;
    return t?.trim() ? t.trim() : null;
  }

  // ------------------------------------------------------------ browser capture
  /**
   * Ask the panel for what the browser recorded on the user's Salesforce tab.
   *
   * The server cannot reach the page — everything agentic runs here, and the extension is the only
   * thing with a view of the DOM. So this is a request/response over the existing channels: an
   * event out on the session stream, an answer back over REST, correlated by requestId.
   *
   * It fails soft on purpose. A closed panel, a non-Salesforce tab or a page loaded before the
   * recorder was injected all end the same way — a resolved promise saying capture is unavailable,
   * never a hung turn. A diagnostic the agent could not fetch is a fact to report, not an error.
   */
  captureBrowser(
    sessionId: string,
    agentId: string,
    kind: BrowserCaptureKind,
    opts: { since?: string | null; filter?: string | null; limit: number },
  ): Promise<BrowserCaptureResponse> {
    const requestId = newId('bc');
    const promise = new Promise<BrowserCaptureResponse>((resolve) => {
      const done = (r: BrowserCaptureResponse) => {
        if (!this.browserWaiters.delete(requestId)) return;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () => done({ requestId, dropped: 0, unavailable: 'The side panel did not answer in time. It is probably closed, or the Salesforce tab was replaced.' }),
        BROWSER_CAPTURE_TIMEOUT_MS,
      );
      // Node keeps the process alive for a pending timer; a capture must never do that.
      timer.unref?.();
      this.browserWaiters.set(requestId, { sessionId, resolve: done });
      this.active
        .get(sessionId)
        ?.abort.signal.addEventListener('abort', () => done({ requestId, dropped: 0, unavailable: 'The run was cancelled.' }), { once: true });
    });
    // Register before emitting: a subscriber that answers synchronously would otherwise beat its
    // own waiter into existence and the reply would be dropped as unknown.
    this.bus.emit(sessionId, {
      type: 'browser.request',
      requestId,
      agentId,
      kind,
      since: opts.since ?? null,
      filter: opts.filter ?? null,
      limit: opts.limit,
    });
    return promise;
  }

  /**
   * The panel answering a browser.request. The session id is checked against the one that made the
   * request: a requestId is a bearer token for a pending tool call, and one session must not be
   * able to complete another's.
   */
  resolveBrowserCapture(sessionId: string, response: BrowserCaptureResponse): boolean {
    const pending = this.browserWaiters.get(response.requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    pending.resolve(response);
    return true;
  }

  // ------------------------------------------------------------ confirmations
  private askConfirmation(
    sessionId: string,
    kind: 'deploy' | 'commit' | 'data_change' | 'destructive' | 'command' | 'custom',
    title: string,
    description: string,
    details: unknown,
    options: { id: string; label: string; style: 'primary' | 'secondary' | 'danger' }[],
    command?: { name: string; input: unknown; sessionAllowable: boolean },
    /** Blast radius in the agent's own words: who and what the change touches. */
    impact?: string | null,
    /** Deploy confirmations only: the staged workspace as the user is approving it. */
    fingerprint?: WorkspaceFingerprint | null,
  ): Promise<ConfirmationAnswer> {
    const c = this.app.repos.confirmations.create({
      sessionId,
      kind,
      title,
      payload: { description, details, options, command, impact: impact ?? null, fingerprint: fingerprint ?? null },
    });
    this.bus.emit(sessionId, {
      type: 'confirmation.requested',
      confirmationId: c.id,
      kind,
      title,
      description,
      details,
      options,
      command,
      impact: impact ?? null,
    });
    this.setStatus(sessionId, 'awaiting_confirmation', title);
    return this.waitForConfirmation(sessionId, c.id);
  }

  /** Block until the user answers a confirmation (or the turn is aborted). */
  private waitForConfirmation(sessionId: string, confirmationId: string): Promise<ConfirmationAnswer> {
    return new Promise<ConfirmationAnswer>((resolve) => {
      this.waiters.set(confirmationId, {
        resolve: (optionId, byUserId) => {
          this.waiters.delete(confirmationId);
          if (this.active.has(sessionId)) this.setStatus(sessionId, 'running', null);
          resolve({ optionId, byUserId: byUserId ?? null, confirmationId });
        },
      });
      const turn = this.active.get(sessionId);
      turn?.abort.signal.addEventListener(
        'abort',
        () => {
          this.waiters.get(confirmationId)?.resolve('cancel');
        },
        { once: true },
      );
    });
  }

  /** User answered a confirmation. If the agent loop is no longer waiting (e.g. server restarted), executes the action directly. */
  async confirm(
    sessionId: string,
    confirmationId: string,
    optionId: string,
    userId: string,
    answerText?: string | null,
  ): Promise<{ executed: boolean; result?: unknown }> {
    const c = this.app.repos.confirmations.byId(confirmationId);
    if (!c || c.sessionId !== sessionId) throw notFound('Confirmation');
    if (c.resolvedAt) throw conflict('Already answered');
    if (!c.payload.options.some((o: any) => o.id === optionId)) throw badRequest('Unknown option');
    this.app.repos.confirmations.resolve(confirmationId, optionId, userId, answerText ?? null);
    this.bus.emit(sessionId, { type: 'confirmation.resolved', confirmationId, optionId, byUserId: userId });
    const waiter = this.waiters.get(confirmationId);
    if (waiter) {
      waiter.resolve(optionId, userId);
      return { executed: false };
    }
    // Orphaned confirmation (the turn that asked died with the process): execute the approved
    // action directly, or record the answer so the next turn delivers it to the model.
    if (optionId === 'deploy' && c.kind === 'deploy') {
      const r = await this.executeDeploy(sessionId, userId, {
        confirmationId,
        approvedFingerprint: (c.payload?.fingerprint as WorkspaceFingerprint | undefined) ?? null,
      });
      this.setStatus(sessionId, 'idle', null);
      return { executed: true, result: r };
    }
    if (optionId === 'commit' && c.kind === 'commit') {
      const r = await this.executeCommit(sessionId, userId, c.payload.details?.message ?? 'Harness changes', !!c.payload.details?.createPullRequest, {
        confirmationId,
      });
      this.setStatus(sessionId, 'idle', null);
      return { executed: true, result: r };
    }
    if (c.kind === 'plan') {
      const revision =
        Number(c.payload.details?.revision ?? (c.payload as any)?.revision ?? 0) || (this.app.repos.sessions.byId(sessionId)?.planRevision ?? 0) + 1;
      const markdown = String(c.payload.details?.markdown ?? '');
      const note = answerText?.trim() || null;
      const summary = String(c.payload.description ?? '');
      if (optionId === 'approve') {
        this.app.repos.sessions.update(sessionId, { planMarkdown: markdown, planApprovedAt: new Date().toISOString(), planRevision: revision });
        this.bus.emit(sessionId, { type: 'plan.resolved', approved: true, revision, note });
        this.app.repos.audit.log({ userId, action: 'plan.approved', target: sessionId, details: { revision, afterRestart: true } });
        if (revision > 1) this.logPlanRevision(sessionId, `Revision ${revision} APPROVED: ${summary}`);
      } else {
        this.app.repos.sessions.update(sessionId, { planRevision: revision });
        this.bus.emit(sessionId, { type: 'plan.resolved', approved: false, revision, note });
        if (optionId === 'changes')
          this.logPlanRevision(sessionId, `Revision ${revision} REJECTED${note ? ` — user said: "${note}"` : ''}. Plan was: ${summary}`);
      }
    }
    // A question's answer is already stored on the confirmation row; deliverOrphanedAnswers
    // turns it into the tool result on the next turn.
    this.setStatus(sessionId, 'idle', null);
    return { executed: false };
  }

  /**
   * Replace the "outcome unknown" placeholders left by a restart on ask_user / submit_plan calls
   * with the answers the user gave afterwards, so the next turn continues from the answer. The
   * confirmation for a dangling call is found through the events it emitted (plan cards by kind,
   * question cards by their question text); one that is still unanswered stays a placeholder.
   */
  private deliverOrphanedAnswers(sessionId: string): void {
    const stored = this.app.repos.messages.list(sessionId, 'orchestrator').map((m) => m.content as import('../ai/types.js').LlmMessage);
    if (!stored.length) return;
    const requested = this.app.repos.events
      .listAfter(sessionId, 0, 20_000)
      .filter(
        (e): e is Extract<typeof e, { type: 'confirmation.requested' }> => e.type === 'confirmation.requested' && (e.kind === 'plan' || e.kind === 'question'),
      );
    if (!requested.length) return;
    const updated = answerOrphanedQuestions(stored, (name, input) => {
      const kind = name === 'submit_plan' ? 'plan' : 'question';
      const candidates = requested.filter((e) => e.kind === kind && (kind === 'plan' || e.title === String((input as any)?.question ?? '')));
      const latest = candidates.at(-1);
      const row = latest ? this.app.repos.confirmations.byId(latest.confirmationId) : undefined;
      if (!row?.resolvedAt) return null;
      const text = (row.payload as { answerText?: string })?.answerText?.trim() || null;
      if (kind === 'plan') {
        if (row.resolvedOption === 'approve')
          return 'The user APPROVED the plan (answered after a restart). Build exactly what it describes; if you discover it has to change materially, submit a revised plan rather than improvising.';
        if (row.resolvedOption === 'changes')
          return `The user asked for CHANGES to the plan (answered after a restart)${text ? `: "${text}"` : ''}. Revise and call submit_plan again.`;
        return 'The plan was dismissed without an answer. Ask the user how to proceed.';
      }
      const options = ((row.payload as any)?.options ?? []) as { id: string; label: string }[];
      const chosen = options.find((o) => o.id === row.resolvedOption);
      if (row.resolvedOption === 'cancel' && !text) return 'The user dismissed the question without answering. Ask again if it still matters.';
      return text
        ? `The user answered: "${text}"${chosen ? ` (after choosing "${chosen.label}")` : ''}`
        : `The user chose: ${chosen?.label ?? row.resolvedOption}`;
    });
    if (updated !== stored) this.app.repos.messages.replace(sessionId, 'orchestrator', toStoredMessages(updated));
  }

  /**
   * A cancelled turn leaves its work half done; items left `in_progress` would otherwise look
   * active forever and confuse the resume path into thinking they are still being worked on.
   */
  private markInterruptedTodosBlocked(sessionId: string): void {
    const items = this.app.repos.todos.get(sessionId);
    if (!items.some((t) => t.status === 'in_progress')) return;
    const updated = items.map((t) => (t.status === 'in_progress' ? { ...t, status: 'blocked' as const, content: t.content } : t));
    this.app.repos.todos.set(sessionId, updated, 'orchestrator');
    this.bus.emit(sessionId, { type: 'todo.updated', agentId: 'orchestrator', items: updated });
  }

  /** On boot: sessions left running by a crashed process are marked failed; orphaned confirmations stay answerable. */
  recoverOnBoot(): void {
    // awaiting_plan is a paused turn like awaiting_confirmation: the card stays answerable, and
    // the answer is applied on the next turn (see confirm and deliverOrphanedAnswers).
    for (const status of ['running', 'awaiting_confirmation', 'awaiting_plan'] as const) {
      for (const s of this.app.repos.sessions.list({ status, limit: 1000 })) {
        this.app.repos.sessions.update(s.id, { status: 'failed' });
        this.bus.emit(s.id, {
          type: 'session.error',
          agentId: null,
          message: 'Server restarted while the session was running. Use "Resume" to continue from the saved todo list and notes.',
          recoverable: true,
        });
        this.bus.emit(s.id, { type: 'session.status', status: 'failed', message: 'Interrupted by server restart — resumable' });
      }
    }
  }
}

/**
 * A content hash per staged path. What the user approved and what was validated must be what
 * ships: the only way to know is to record the workspace at those two moments and recompute it
 * immediately before the deploy.
 */
export type WorkspaceFingerprint = Record<string, string>;

export function workspaceFingerprint(files: readonly { path: string; content: string; action: string }[]): WorkspaceFingerprint {
  const out: WorkspaceFingerprint = {};
  for (const f of files) out[f.path] = sha256(`${f.action}\n${f.content}`);
  return out;
}

/** Paths that were added, removed or edited between two fingerprints, in a sentence a user can read. */
export function fingerprintDrift(before: WorkspaceFingerprint, after: WorkspaceFingerprint): string[] {
  const changes: string[] = [];
  for (const path of Object.keys(before)) {
    if (!(path in after)) changes.push(`${path} (removed)`);
    else if (before[path] !== after[path]) changes.push(`${path} (changed)`);
  }
  for (const path of Object.keys(after)) if (!(path in before)) changes.push(`${path} (added)`);
  return changes.sort();
}

/**
 * Context pressure thresholds, as a percentage of the model's window. Compaction targets 55%, so a
 * conversation sitting this far above it is one the two-stage path is no longer keeping up with.
 */
const CONTEXT_WARNING_PERCENT = 75;
const CONTEXT_CRITICAL_PERCENT = 90;

/**
 * A session nobody has touched for this long, with todo items still open, is spun down. The
 * consultant decides when a session is *done*; this only stops abandoned ones from looking alive.
 */
const IDLE_SPIN_DOWN_MS = 12 * 60 * 60 * 1000;
/** How often the sweep runs. Cheap: a handful of indexed reads. */
const IDLE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** What every gated command and every plan must say before a user is asked to approve it. */
const IMPACT_REQUIRED_MESSAGE =
  'REFUSED: provide an "impact" — who and what this affects, in plain language a business admin can judge (users, profiles, automations, record counts) — and try again.';

/** A metadata component described the way a consultant would say it out loud. */
export function plainComponent(metadataType: string, fullName: string): string {
  const [a, b] = fullName.split('.');
  switch (metadataType) {
    case 'CustomField':
      return b ? `the ${b} field on ${a}` : `the ${fullName} field`;
    case 'CustomObject':
      return `the ${fullName} object`;
    case 'Layout':
      return `the ${(b ?? fullName).replace(/-/g, ' ')} page layout`;
    case 'Flow':
      return `the ${fullName} flow`;
    case 'ApexClass':
      return `the ${fullName} Apex class`;
    case 'ApexTrigger':
      return `the ${fullName} Apex trigger`;
    case 'PermissionSet':
      return `the ${fullName} permission set`;
    case 'ValidationRule':
      return b ? `the ${b} validation rule on ${a}` : `the ${fullName} validation rule`;
    default:
      return `${fullName} (${metadataType})`;
  }
}

/** "a, b and c" — a list a non-developer can read. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** File reads a researcher may spend, by requested thoroughness. */
const READ_BUDGETS: Record<string, number> = { quick: 8, medium: 40, thorough: 70 };
/** Loop iterations a researcher may spend, by requested thoroughness (never above the role binding). */
const ITERATION_BUDGETS: Record<string, number> = { quick: 12, medium: 30, thorough: 60 };

/** Sub-agent roles that build things — delegating to one is never trivial. */
const BUILDER_ROLES = new Set(['metadata_builder', 'flow_builder', 'apex_builder']);
/** Metadata types that always need sign-off: code and automation carry runtime behaviour. */
const PLAN_REQUIRED_TYPES = new Set(['ApexClass', 'ApexTrigger', 'Flow', 'LightningComponentBundle', 'AuraDefinitionBundle']);
const PLAN_REQUIRED_MESSAGE =
  'REFUSED: this session has no approved plan yet, and this change is not a trivial one. Finish investigating, then call submit_plan describing what you will change in Salesforce terms (objects, fields, flows, permissions), how you will validate it and what the user will notice. Wait for approval before staging.';

/** User-facing explanation for each non-normal stop. */
function stopReasonMessage(reason: string): string {
  switch (reason) {
    case 'max_iterations':
      return 'Stopped: the agent reached its step limit.';
    case 'refusal':
      return 'Stopped: the model declined the request.';
    case 'provider_error':
      return 'Stopped: the AI provider request failed.';
    case 'cancelled':
      return 'Cancelled.';
    case 'cost_ceiling':
      return 'Stopped: the spend ceiling for this session was reached. An admin can raise it, then resume.';
    case 'stuck_loop':
      return 'Stopped: the agent repeated the same failing action without progress.';
    case 'context_exhausted':
      return 'Stopped: the conversation outgrew the model context window.';
    case 'awaiting_user':
      return 'Waiting for your answer.';
    default:
      return `Stopped: ${reason}`;
  }
}

function orgSlug(org: OrgRow): string {
  return (
    org.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || org.id
  );
}
function yamlStr(s: string): string {
  return JSON.stringify(String(s));
}
export type { Client };
