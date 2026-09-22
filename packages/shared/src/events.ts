import { z } from 'zod';
import { AgentRole, SessionStatus, TodoItem, OrgLimits, PageContext, BrowserCaptureKind } from './domain.js';

/**
 * Real-time event protocol streamed from the server to the extension/admin UI
 * over Server-Sent Events. Every event carries the session id and a monotonically
 * increasing sequence so clients can resume after reconnect (`?after=<seq>`).
 */

const base = {
  seq: z.number().int(),
  sessionId: z.string(),
  at: z.string(),
};

/** A phase is an attribution label, not a claim about model reasoning or decoding. */
export const WorkPhase = z.enum(['research', 'planning', 'build', 'review', 'documentation']);
const modelCall = {
  agentId: z.string(),
  role: AgentRole,
  callId: z.string(),
  modelId: z.string(),
  provider: z.string(),
  phase: WorkPhase,
  purpose: z.enum(['turn', 'wrap_up', 'compaction']),
  attempt: z.number().int().positive(),
};
export const ModelStartedEvent = z.object({ ...base, ...modelCall, type: z.literal('model.started') });
export const ModelFinishedEvent = z.object({
  ...base,
  ...modelCall,
  type: z.literal('model.finished'),
  durationMs: z.number().nonnegative(),
  /** First observable text/thinking/tool callback; null for a non-streaming response. */
  firstOutputMs: z.number().nonnegative().nullable(),
  outcome: z.enum(['completed', 'failed', 'cancelled']),
  /** Per-call usage, never the cumulative session counters. Unknown on provider errors. */
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), cachedInputTokens: z.number() }).nullable(),
});

/** A sub-agent was spawned by the orchestrator. */
export const AgentSpawnedEvent = z.object({
  ...base,
  type: z.literal('agent.spawned'),
  agentId: z.string(),
  parentAgentId: z.string().nullable(),
  role: AgentRole,
  modelId: z.string(),
  objective: z.string(),
});

export const AgentFinishedEvent = z.object({
  ...base,
  type: z.literal('agent.finished'),
  agentId: z.string(),
  role: AgentRole,
  ok: z.boolean(),
  summary: z.string(),
});

/** Streaming assistant text, chunked. */
export const AssistantDeltaEvent = z.object({
  ...base,
  type: z.literal('assistant.delta'),
  agentId: z.string(),
  role: AgentRole,
  messageId: z.string(),
  delta: z.string(),
});

export const AssistantMessageEvent = z.object({
  ...base,
  type: z.literal('assistant.message'),
  agentId: z.string(),
  role: AgentRole,
  messageId: z.string(),
  text: z.string(),
  status: z.enum(['normal', 'proactive']).optional(),
  attachments: z.array(z.string()).optional(),
});

/** Thinking summary (when the provider exposes it). */
export const ThinkingEvent = z.object({
  ...base,
  type: z.literal('assistant.thinking'),
  agentId: z.string(),
  role: AgentRole,
  text: z.string(),
});

export const ToolCallEvent = z.object({
  ...base,
  type: z.literal('tool.call'),
  agentId: z.string(),
  role: AgentRole,
  toolCallId: z.string(),
  tool: z.string(),
  /** Human readable one-liner for visual mode, e.g. "Querying 25 Accounts". */
  label: z.string(),
  input: z.unknown(),
});

export const ToolResultEvent = z.object({
  ...base,
  type: z.literal('tool.result'),
  agentId: z.string(),
  role: AgentRole,
  toolCallId: z.string(),
  tool: z.string(),
  ok: z.boolean(),
  label: z.string(),
  /** Structured result; UI renders visually by `tool` (table for SOQL, tree for metadata, etc.). */
  output: z.unknown(),
  durationMs: z.number(),
});

/** Workspace file changed (metadata staged for validation/deploy). */
export const WorkspaceFileEvent = z.object({
  ...base,
  type: z.literal('workspace.file'),
  path: z.string(),
  action: z.enum(['created', 'modified', 'deleted']),
  metadataType: z.string().nullable(),
  fullName: z.string().nullable(),
});

export const ValidationResultEvent = z.object({
  scope: z.enum(['full', 'slice']).optional(),
  ...base,
  type: z.literal('deploy.validation'),
  deployId: z.string(),
  ok: z.boolean(),
  attempt: z.number().int(),
  componentsTotal: z.number().int(),
  componentsFailed: z.number().int(),
  testsTotal: z.number().int(),
  testsFailed: z.number().int(),
  codeCoverage: z.number().nullable(),
  failures: z.array(
    z.object({
      componentType: z.string().nullable(),
      fullName: z.string().nullable(),
      fileName: z.string().nullable(),
      problem: z.string(),
      problemType: z.string().nullable(),
      lineNumber: z.number().nullable(),
      columnNumber: z.number().nullable(),
    }),
  ),
});

/** Agent loop paused waiting for a human decision. */
export const ConfirmationRequestedEvent = z.object({
  ...base,
  type: z.literal('confirmation.requested'),
  confirmationId: z.string(),
  kind: z.enum(['deploy', 'commit', 'data_change', 'destructive', 'command', 'plan', 'question', 'custom']),
  title: z.string(),
  /** AI-written explanation of WHY the command is needed. */
  description: z.string(),
  /**
   * Who and what this touches, in the user's words: the blast radius the approver needs in order to
   * judge the change. Separate from `description`, which says why.
   */
  impact: z.string().nullable().optional(),
  /** For kind=command: the allow-listed command and its exact input, shown to the user before execution. */
  command: z.object({ name: z.string(), input: z.unknown(), sessionAllowable: z.boolean() }).optional(),
  /** Visual summary of what will happen (components, records, files). */
  details: z.unknown(),
  options: z.array(z.object({ id: z.string(), label: z.string(), style: z.enum(['primary', 'secondary', 'danger']).default('secondary') })),
});

export const ConfirmationResolvedEvent = z.object({
  ...base,
  type: z.literal('confirmation.resolved'),
  confirmationId: z.string(),
  optionId: z.string(),
  byUserId: z.string(),
});

export const DeployResultEvent = z.object({
  ...base,
  type: z.literal('deploy.result'),
  deployId: z.string(),
  ok: z.boolean(),
  sfDeployId: z.string().nullable(),
  componentsDeployed: z.number().int(),
  message: z.string(),
});

/**
 * What the org actually contains after a deploy, read back component by component. A deploy that
 * reports success has only been accepted by Salesforce; this is the check that it landed.
 */
export const DeployVerifiedEvent = z.object({
  ...base,
  type: z.literal('deploy.verified'),
  deployId: z.string(),
  ok: z.boolean(),
  components: z.array(
    z.object({
      metadataType: z.string(),
      fullName: z.string(),
      status: z.enum(['confirmed', 'missing', 'unreadable']),
      note: z.string().nullable().optional(),
    }),
  ),
  summary: z.string(),
});

/**
 * The conversation is approaching the point where it can no longer be compacted into the model's
 * context window. Warning the user early is the difference between choosing to start a fresh
 * session and having one die mid-build.
 */
export const ContextPressureEvent = z.object({
  ...base,
  type: z.literal('session.context'),
  usedTokens: z.number().int(),
  limitTokens: z.number().int(),
  percent: z.number(),
  /** `warning` still recovers by compacting; `critical` means the next turn is likely to be refused. */
  level: z.enum(['warning', 'critical']),
  message: z.string(),
});

export const GithubCommitEvent = z.object({
  ...base,
  type: z.literal('github.commit'),
  owner: z.string(),
  repo: z.string(),
  branch: z.string(),
  sha: z.string(),
  url: z.string(),
  filesChanged: z.number().int(),
  message: z.string(),
  pullRequestUrl: z.string().nullable(),
});

export const DocWrittenEvent = z.object({
  ...base,
  type: z.literal('doc.written'),
  docId: z.string(),
  path: z.string(),
  title: z.string(),
});

/** The user navigated: the session's page context now points somewhere else in the org. */
export const PageContextEvent = z.object({
  ...base,
  type: z.literal('session.page'),
  pageContext: PageContext,
});

/**
 * The agent is asking the panel for what the browser recorded. The panel answers by POSTing to
 * /sessions/:id/browser-capture with the same requestId; the tool call blocks until it does or the
 * request times out. It is a request, not a command: a panel that is closed simply never answers,
 * and the tool says so rather than hanging the turn.
 */
export const BrowserRequestEvent = z.object({
  ...base,
  type: z.literal('browser.request'),
  requestId: z.string(),
  agentId: z.string(),
  kind: BrowserCaptureKind,
  /** Only entries at or after this ISO timestamp. */
  since: z.string().nullable(),
  filter: z.string().nullable(),
  limit: z.number().int(),
});

export const StatusEvent = z.object({
  ...base,
  type: z.literal('session.status'),
  status: SessionStatus,
  message: z.string().nullable(),
});

export const UsageEvent = z.object({
  ...base,
  type: z.literal('session.usage'),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  costUsd: z.number(),
});

export const ErrorEvent = z.object({
  ...base,
  type: z.literal('session.error'),
  agentId: z.string().nullable(),
  message: z.string(),
  recoverable: z.boolean(),
});

export const UserMessageEvent = z.object({
  ...base,
  type: z.literal('user.message'),
  userId: z.string(),
  text: z.string(),
});

/** Orchestrator todo list replaced (full list). */
export const TodoUpdatedEvent = z.object({ ...base, type: z.literal('todo.updated'), agentId: z.string(), items: z.array(TodoItem) });
/** A sub-agent wrote a scratchpad note. */
export const NoteWrittenEvent = z.object({
  ...base,
  type: z.literal('note.written'),
  noteId: z.string(),
  agentId: z.string(),
  role: AgentRole,
  title: z.string(),
  tags: z.array(z.string()),
});
/** Org API limits snapshot with warnings. */
export const OrgLimitsEvent = z.object({ ...base, type: z.literal('org.limits'), limits: OrgLimits });
/** A tool call was refused by policy/allow list (visible so the user understands why the agent stopped). */
export const PolicyBlockedEvent = z.object({
  ...base,
  type: z.literal('policy.blocked'),
  agentId: z.string(),
  tool: z.string(),
  rule: z.string(),
  message: z.string(),
});
/** A spend ceiling was reached; the run stopped and is resumable once an admin raises the limit. */
export const CostLimitEvent = z.object({
  ...base,
  type: z.literal('session.limit'),
  scope: z.enum(['turn', 'session', 'client_month']),
  limitUsd: z.number(),
  spentUsd: z.number(),
  message: z.string(),
});
/** The lead agent submitted a plan for approval (plan mode). */
export const PlanSubmittedEvent = z.object({
  ...base,
  type: z.literal('plan.submitted'),
  confirmationId: z.string(),
  revision: z.number(),
  markdown: z.string(),
});
/** The user approved the plan or asked for changes. */
export const PlanResolvedEvent = z.object({
  ...base,
  type: z.literal('plan.resolved'),
  approved: z.boolean(),
  revision: z.number(),
  note: z.string().nullable(),
});

export const SessionEvent = z.discriminatedUnion('type', [
  ModelStartedEvent,
  ModelFinishedEvent,
  CostLimitEvent,
  PlanSubmittedEvent,
  PlanResolvedEvent,
  TodoUpdatedEvent,
  NoteWrittenEvent,
  OrgLimitsEvent,
  PolicyBlockedEvent,
  AgentSpawnedEvent,
  AgentFinishedEvent,
  AssistantDeltaEvent,
  AssistantMessageEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
  WorkspaceFileEvent,
  ValidationResultEvent,
  ConfirmationRequestedEvent,
  ConfirmationResolvedEvent,
  DeployResultEvent,
  DeployVerifiedEvent,
  ContextPressureEvent,
  GithubCommitEvent,
  DocWrittenEvent,
  StatusEvent,
  PageContextEvent,
  BrowserRequestEvent,
  UsageEvent,
  ErrorEvent,
  UserMessageEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent['type'];

/**
 * Every event type, derived from the union rather than typed out again. The SSE stream names each
 * event (`event: <type>`), so a client subscribes per type — and a hand-kept list silently drops
 * whatever it forgot. It had already lost the plan cards and the spend-ceiling event in the admin
 * console. Derive it and that cannot happen again.
 */
export const SESSION_EVENT_TYPES: SessionEventType[] = SessionEvent.options.map((o) => o.shape.type.value as SessionEventType);
