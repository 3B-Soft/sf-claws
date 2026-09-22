import { z } from 'zod';
import { ImpactCommand, PermissionRule } from './permissions.js';

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export const UserRole = z.enum(['superadmin', 'admin', 'user']);
export type UserRole = z.infer<typeof UserRole>;

export const UserStatus = z.enum(['pending', 'active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatus>;

export const UiMode = z.enum(['visual', 'pro']);
export type UiMode = z.infer<typeof UiMode>;

export const User = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  role: UserRole,
  status: UserStatus,
  uiMode: UiMode.default('visual'),
  createdAt: z.string(),
  approvedAt: z.string().nullable().optional(),
  approvedBy: z.string().nullable().optional(),
  lastSeenAt: z.string().nullable().optional(),
});
export type User = z.infer<typeof User>;

// ---------------------------------------------------------------------------
// Clients & Salesforce orgs
// ---------------------------------------------------------------------------

/**
 * Always-loaded agent instructions, the equivalent of a CLAUDE.md checked into a repository.
 * Unlike a skill it is not role-filtered and not a menu entry: every agent on every session reads
 * it, so it is the right home for conventions and for facts about a client's org that never change.
 */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 20_000;
export const AgentInstructions = z.string().max(AGENT_INSTRUCTIONS_MAX_CHARS);

export const Client = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  /** Client-wide agent instructions, injected into every session's system prompt. */
  instructions: z.string().nullable().optional(),
  /** How this client's Salesforce orgs authenticate to the control plane. */
  salesforceAuthMode: z.enum(['external_app', 'browser_session']).default('external_app'),
  createdAt: z.string(),
});
export type Client = z.infer<typeof Client>;

/**
 * Client membership: which users may see and work on a client. A super admin implicitly belongs to
 * every client; everyone else, including platform admins, sees only the clients they are a member
 * of. `member` works within the client; `admin` additionally sees every session of that client,
 * not only their own.
 */
export const ClientMemberRole = z.enum(['member', 'admin']);
export type ClientMemberRole = z.infer<typeof ClientMemberRole>;

export const ClientMember = z.object({
  userId: z.string(),
  clientId: z.string(),
  role: ClientMemberRole,
  createdAt: z.string(),
  /** Denormalised for display; present on the membership listing routes. */
  email: z.string().optional(),
  displayName: z.string().optional(),
  clientName: z.string().optional(),
});
export type ClientMember = z.infer<typeof ClientMember>;

/**
 * What the user is looking at in Salesforce, captured by the extension from the active tab. Sent
 * when a session is created and again with every message: over a long session the user moves
 * around the org, and an agent still reasoning about the record they opened an hour ago is worse
 * than one with no page context at all.
 */
export const PageContext = z.object({
  url: z.string().max(2000).optional(),
  title: z.string().max(500).optional(),
  recordId: z.string().max(20).optional(),
  objectApiName: z.string().max(200).optional(),
  flowId: z.string().max(20).optional(),
  setupPage: z.string().max(200).optional(),
});
export type PageContext = z.infer<typeof PageContext>;

/**
 * What the agent can ask the browser for. Both are recordings the extension already holds — asking
 * costs a round trip to the panel, not a page reload, and nothing is captured when no session is
 * open on the tab.
 */
export const BrowserCaptureKind = z.enum(['console', 'network']);
export type BrowserCaptureKind = z.infer<typeof BrowserCaptureKind>;

export const ConsoleEntry = z.object({
  at: z.string(),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
  text: z.string(),
  /** Where it came from, when the browser reported a stack. */
  source: z.string().nullable().optional(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntry>;

export const NetworkEntry = z.object({
  at: z.string(),
  method: z.string(),
  url: z.string(),
  status: z.number().nullable(),
  durationMs: z.number().nullable(),
  /** Set when the request never produced a response (network error, CORS, aborted). */
  error: z.string().nullable().optional(),
  /** Response body for a failed call only, truncated. A successful call's body is the page's data, not a diagnostic. */
  responseBody: z.string().nullable().optional(),
});
export type NetworkEntry = z.infer<typeof NetworkEntry>;

export const OrgKind = z.enum(['production', 'sandbox', 'scratch', 'developer']);
export type OrgKind = z.infer<typeof OrgKind>;

export const OrgConnectionStatus = z.enum(['connected', 'disconnected', 'expired', 'error']);
export type OrgConnectionStatus = z.infer<typeof OrgConnectionStatus>;

export const SalesforceOrg = z.object({
  id: z.string(),
  clientId: z.string(),
  label: z.string(),
  kind: OrgKind,
  /** 18-char Salesforce org id, when known. */
  sfOrgId: z.string().nullable().optional(),
  instanceUrl: z.string().nullable().optional(),
  /** https://login.salesforce.com, https://test.salesforce.com or a MyDomain login URL. */
  loginUrl: z.string(),
  /** Consumer Key of the org's own Connected App; null means the server-wide SF_CLIENT_ID. */
  consumerKey: z.string().nullable().optional(),
  apiVersion: z.string().default('62.0'),
  username: z.string().nullable().optional(),
  status: OrgConnectionStatus,
  /** Production orgs and orgs flagged protected require explicit confirmation + policies for every deploy. */
  protected: z.boolean().default(false),
  githubRepoId: z.string().nullable().optional(),
  /** Org-specific agent instructions, appended after the client's so the more specific one wins. */
  instructions: z.string().nullable().optional(),
  createdAt: z.string(),
  lastConnectedAt: z.string().nullable().optional(),
});
export type SalesforceOrg = z.infer<typeof SalesforceOrg>;

// ---------------------------------------------------------------------------
// GitHub integration (per client org)
// ---------------------------------------------------------------------------

export const GithubRepo = z.object({
  id: z.string(),
  clientId: z.string(),
  owner: z.string(),
  repo: z.string(),
  defaultBranch: z.string().default('main'),
  /** Root of the SFDX project inside the repo, e.g. "force-app/main/default". */
  sourceRoot: z.string().default('force-app/main/default'),
  /** Where session documentation is written, relative to repo root. */
  docsRoot: z.string().default('docs/harness'),
  /** Commit strategy chosen by the super admin. */
  commitStrategy: z.enum(['direct', 'branch-per-session', 'branch-per-task', 'pull-request']).default('branch-per-session'),
  branchPrefix: z.string().default('harness/'),
  hasToken: z.boolean(),
  createdAt: z.string(),
});
export type GithubRepo = z.infer<typeof GithubRepo>;

// ---------------------------------------------------------------------------
// AI models & providers
// ---------------------------------------------------------------------------

export const AiProvider = z.enum(['anthropic', 'openai', 'gemini', 'deepseek', 'deepinfra']);
export type AiProvider = z.infer<typeof AiProvider>;

export const AiModel = z.object({
  id: z.string(),
  provider: AiProvider,
  /** Provider model id, e.g. claude-opus-5, gpt-5, deepseek-chat. */
  modelId: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  /** USD per 1M tokens. */
  inputCostPerM: z.number(),
  outputCostPerM: z.number(),
  cachedInputCostPerM: z.number().nullable().optional(),
  maxOutputTokens: z.number().default(16000),
  contextWindow: z.number().default(200000),
  supportsThinking: z.boolean().default(false),
  /**
   * Sampling dials, set by the super admin. Null means "send nothing and take the provider default",
   * which is also the only safe value for a thinking model: Anthropic rejects temperature alongside
   * extended thinking, and the OpenAI reasoning models only accept the default.
   */
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  createdAt: z.string(),
});
export type AiModel = z.infer<typeof AiModel>;

/**
 * Agent roles in the swarm. Each role is bound to a model by the super admin.
 */
export const AgentRole = z.enum([
  'orchestrator', // plans, delegates, talks to the user
  'general', // multi-step implementation and investigation
  'explore', // read-only discovery
  'plan', // read-only architecture and implementation planning
  'verify', // independent verification with evidence
  'analyst', // reads org: SOQL, describe, debug logs, flow inspection
  'metadata_builder', // writes/edits metadata (objects, fields, layouts, flexipages)
  'flow_builder', // Flow XML specialist
  'apex_builder', // Apex / LWC / triggers (pro mode)
  'reviewer', // quality gate, policy enforcement, reads skills
  'doc_writer', // technical + end-user documentation
  'researcher', // searches linked knowledge sources (product docs + product source repos)
  'summarizer', // cheap: compaction, titles, memory extraction
]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Session work items are distinct from client/project tasks and background agent runs. */
export const AgentTask = z.object({
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  owner: z.string().nullable(),
  blockedBy: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
});
export type AgentTask = z.infer<typeof AgentTask>;

export const RoleModelBinding = z.object({
  role: AgentRole,
  modelId: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  maxIterations: z.number().int().positive().default(40),
});
export type RoleModelBinding = z.infer<typeof RoleModelBinding>;

export const ProviderCredential = z.object({
  provider: AiProvider,
  hasKey: z.boolean(),
  baseUrl: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});
export type ProviderCredential = z.infer<typeof ProviderCredential>;

// ---------------------------------------------------------------------------
// Skills & knowledge (markdown managed by super admin)
// ---------------------------------------------------------------------------

/**
 * A place the agents can read domain knowledge from: a documentation repository of markdown, or a
 * source repository they can search. Deliberately generic — an agency configures its own product
 * docs and product repos; nothing about any particular product is baked into the code.
 */
export const KnowledgeSourceKind = z.enum(['docs', 'repo']);
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKind>;

export const KnowledgeSource = z.object({
  id: z.string(),
  kind: KnowledgeSourceKind,
  name: z.string(),
  /** GitHub reference as owner/repo#branch. */
  repoRef: z.string(),
  /** Admin-written orientation shown to the agents: what this source is and when to use it. */
  guidance: z.string(),
  /** 'global' sources serve every client; 'client' sources only the client that owns them. */
  scope: z.enum(['global', 'client']),
  clientId: z.string().nullable(),
  enabled: z.boolean(),
  hasToken: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

/**
 * A specialist the super admin defines without a deploy: a name, when to use it, and extra
 * instructions layered on one of the built-in roles. The base role decides which tools it gets, so
 * a specialist can never reach beyond what that role is already allowed to do.
 */
export const CustomAgent = z.object({
  id: z.string(),
  name: z.string(),
  /** Shown to the orchestrator so it knows when to consult this specialist. */
  whenToUse: z.string(),
  /** Built-in role whose tool set and safety posture this specialist inherits. */
  baseRole: AgentRole,
  /** Appended to the base role's system prompt. */
  instructions: z.string(),
  scope: z.enum(['global', 'client']),
  clientId: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomAgent = z.infer<typeof CustomAgent>;

export const SkillScope = z.enum(['global', 'client', 'org']);
export type SkillScope = z.infer<typeof SkillScope>;

export const SkillKind = z.enum([
  'knowledge', // how our managed packages / patterns work
  'policy', // commit strategy, restrictions, forbidden metadata, approvals
  'quality', // naming conventions, code quality, test requirements
  'playbook', // step-by-step recipes for common tasks
]);
export type SkillKind = z.infer<typeof SkillKind>;

export const Skill = z.object({
  id: z.string(),
  name: z.string(),
  kind: SkillKind,
  scope: SkillScope,
  clientId: z.string().nullable().optional(),
  orgId: z.string().nullable().optional(),
  /** Which roles receive this skill in their system prompt. Empty = all. */
  roles: z.array(AgentRole).default([]),
  /** Markdown body. */
  content: z.string(),
  enabled: z.boolean().default(true),
  version: z.number().int().default(1),
  updatedAt: z.string(),
  updatedBy: z.string().nullable().optional(),
});
export type Skill = z.infer<typeof Skill>;

/** Structured policy the runtime enforces programmatically (in addition to the prose). */
export const PolicyRules = z.object({
  forbiddenMetadataTypes: z.array(z.string()).default([]),
  /** Glob-like patterns of fullNames that must never be modified, e.g. "yourns__*". */
  protectedComponents: z.array(z.string()).default([]),
  requireTestsForApex: z.boolean().default(true),
  minCodeCoverage: z.number().min(0).max(100).default(75),
  /** Require confirmation for every deploy even in sandboxes. */
  alwaysConfirmDeploy: z.boolean().default(true),
  /** Only allow deploys to production when session was started in pro mode. */
  productionRequiresProMode: z.boolean().default(false),
  maxComponentsPerDeploy: z.number().int().positive().default(200),
  allowDataModification: z.boolean().default(false),
  /**
   * Allow list of commands that impact Salesforce data/metadata. A command not covered by the list
   * is refused outright. What is covered always shows the user an AI-written "why" plus the exact
   * command before it runs.
   *
   * Entries are permission rules: a bare command name, or one scoped to a subject pattern such as
   * `update_record(Account)` or `delete_component(*__c)`. The default is every command unscoped —
   * the gate, not the list, is what stops things by default.
   */
  impactAllowList: z.array(PermissionRule).default([...ImpactCommand.options]),
  /**
   * Deny rules, evaluated first and absolute: a match refuses the command however broadly the allow
   * list is written, and a session grant does not override it. This is where "never touch these"
   * belongs, because it survives an allow list someone later widens.
   */
  impactDenyList: z.array(PermissionRule).default([]),
  /**
   * Commands the user may "always allow for this session" after the first approval. Deploys and
   * commits never qualify. A session grant skips the *prompt*, never the allow and deny rules, so
   * its reach is only ever as wide as the rule that permitted the command in the first place.
   */
  sessionAllowable: z.array(PermissionRule).default(['soql_query_tooling', 'run_apex_tests']),
  /** Warn when an org limit (e.g. DailyApiRequests) crosses this percentage of usage. */
  apiLimitWarnPercent: z.number().min(1).max(100).default(80),
  /**
   * Hard spend ceilings, enforced BEFORE each model call (0 = unlimited). A run that would cross a
   * ceiling is stopped with `cost_ceiling` and the session stays resumable once an admin raises it.
   */
  maxSessionCostUsd: z.number().min(0).default(0),
  maxTurnCostUsd: z.number().min(0).default(0),
  maxClientMonthlyCostUsd: z.number().min(0).default(0),
  /**
   * Reserved spend, on top of a ceiling, that only the documentation guarantee may use — so hitting
   * a ceiling never leaves staged, validated work undocumented.
   */
  costCeilingDocReserveUsd: z.number().min(0).default(0.25),
  /**
   * When the lead agent must get a plan approved before staging metadata.
   * `nontrivial` (default) exempts a single fully specified component change.
   */
  requirePlanApproval: z.enum(['always', 'nontrivial', 'never']).default('nontrivial'),
  /**
   * Whether `request_deploy` needs a reviewer verdict for the current workspace state.
   * `nontrivial` (default) requires one when the workspace holds code, automation, or more than
   * one component; `always` requires one for every deploy; `never` disables the gate.
   */
  requireReviewerVerdict: z.enum(['always', 'nontrivial', 'never']).default('nontrivial'),
});
export type PolicyRules = z.infer<typeof PolicyRules>;

// ---------------------------------------------------------------------------
// Projects, tasks, sessions
// ---------------------------------------------------------------------------

export const TaskStatus = z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Project = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.enum(['active', 'archived']).default('active'),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const Task = z.object({
  id: z.string(),
  projectId: z.string(),
  orgId: z.string().nullable().optional(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: TaskStatus,
  assigneeId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const SessionStatus = z.enum([
  'idle', // waiting for user input
  'running', // agent loop active
  'awaiting_confirmation', // paused for user approval (deploy, commit, destructive)
  'awaiting_plan', // paused for the user to approve the proposed plan before any staging
  'completed',
  'failed',
  'cancelled',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: z.string(),
  userId: z.string(),
  clientId: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  title: z.string(),
  status: SessionStatus,
  uiMode: UiMode,
  /** Aggregate usage. */
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cachedInputTokens: z.number().default(0),
  costUsd: z.number().default(0),
  helpful: z.boolean().nullable().optional(),
  feedbackNote: z.string().nullable().optional(),
  /** GitHub branch used by this session once the first commit happened. */
  branchName: z.string().nullable().optional(),
  /** The plan the user approved for this session (plan mode), and its revision counter. */
  planMarkdown: z.string().nullable().optional(),
  planApprovedAt: z.string().nullable().optional(),
  planRevision: z.number().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
});
export type Session = z.infer<typeof Session>;

export const UsageRecord = z.object({
  id: z.string(),
  sessionId: z.string(),
  userId: z.string(),
  clientId: z.string(),
  role: AgentRole,
  provider: AiProvider,
  modelId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  createdAt: z.string(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

// ---------------------------------------------------------------------------
// Documentation log (persistent memory)
// ---------------------------------------------------------------------------

export const DocEntry = z.object({
  id: z.string(),
  sessionId: z.string(),
  clientId: z.string(),
  orgId: z.string(),
  /** Repo-relative path the doc was/will be committed to. */
  path: z.string(),
  title: z.string(),
  /** Full markdown: technical + end-user sections. */
  markdown: z.string(),
  /** Short memory summary used for retrieval in later sessions. */
  summary: z.string(),
  tags: z.array(z.string()).default([]),
  committedSha: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type DocEntry = z.infer<typeof DocEntry>;

// ---------------------------------------------------------------------------
// Session todo list & scratchpad (agent working memory, visible to the user)
// ---------------------------------------------------------------------------

export const TodoStatus = z.enum(['pending', 'in_progress', 'completed', 'blocked']);
export type TodoStatus = z.infer<typeof TodoStatus>;
export const TodoItem = z.object({
  id: z.string(),
  content: z.string(),
  /** Present-tense form shown while in progress, e.g. "Adding Renewal_Date__c to Account". */
  activeForm: z.string().optional(),
  status: TodoStatus,
  ownerAgentId: z.string().nullable().optional(),
});
export type TodoItem = z.infer<typeof TodoItem>;

export const Note = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  role: AgentRole,
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof Note>;

/** Salesforce org limit snapshot (subset of /limits) with warning flags. */
export const OrgLimit = z.object({ name: z.string(), max: z.number(), remaining: z.number(), usedPercent: z.number(), warning: z.boolean() });
export type OrgLimit = z.infer<typeof OrgLimit>;
export const OrgLimits = z.object({ orgId: z.string(), fetchedAt: z.string(), limits: z.array(OrgLimit), warnings: z.array(z.string()) });
export type OrgLimits = z.infer<typeof OrgLimits>;
