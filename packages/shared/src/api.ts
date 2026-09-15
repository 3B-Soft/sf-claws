import { z } from 'zod';
import {
  AgentRole,
  AiModel,
  AiProvider,
  Client,
  ClientMemberRole,
  DocEntry,
  GithubRepo,
  OrgKind,
  PolicyRules,
  Project,
  ProviderCredential,
  RoleModelBinding,
  SalesforceOrg,
  Session,
  Skill,
  SkillKind,
  SkillScope,
  Task,
  TaskStatus,
  UiMode,
  UsageRecord,
  User,
  UserRole,
  TodoItem,
  Note,
  PageContext,
  ConsoleEntry,
  NetworkEntry,
} from './domain.js';
import { DeployRun, WorkspaceFile } from './metadata.js';

/**
 * REST API contract. All routes are prefixed with /api/v1.
 * Auth: `Authorization: Bearer <jwt>`. Extension and admin UI use the same tokens.
 *
 * Errors: { error: { code: string, message: string, details?: unknown } } with proper HTTP status.
 */

export const API_PREFIX = '/api/v1';

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

// ----------------------------- auth ----------------------------------------
// POST /auth/register    -> creates pending user (unless first user => superadmin)
export const RegisterRequest = z.object({ email: z.string().email(), password: z.string().min(10), displayName: z.string().min(1) });
// POST /auth/login       -> { token, user }
export const LoginRequest = z.object({ email: z.string().email(), password: z.string() });
export const AuthResponse = z.object({ token: z.string(), user: User, expiresAt: z.string() });
// GET  /auth/me          -> User
// POST /auth/logout
// POST /auth/device/start   -> { code, expiresAt }  (extension pairing: user enters code in admin UI)
// POST /auth/device/approve -> { ok } (authenticated web user approves code)
// GET  /auth/device/poll?code=... -> AuthResponse | 202 pending
export const DeviceStartResponse = z.object({ code: z.string(), expiresAt: z.string(), verifyUrl: z.string() });

// ----------------------------- admin: users --------------------------------
// GET   /admin/users
// POST  /admin/users/:id/approve   { role? }
// POST  /admin/users/:id/disable
// PATCH /admin/users/:id           { role?, displayName?, uiMode? }
export const ApproveUserRequest = z.object({ role: UserRole.default('user') });
export const UpdateUserRequest = z.object({
  role: UserRole.optional(),
  displayName: z.string().optional(),
  uiMode: UiMode.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

// ----------------------------- admin: providers & models -------------------
// GET  /admin/providers                   -> ProviderCredential[]
// PUT  /admin/providers/:provider         { apiKey, baseUrl? }
// GET  /admin/models                      -> AiModel[]
// POST /admin/models                      CreateModelRequest
// PATCH/DELETE /admin/models/:id
// GET  /admin/role-bindings               -> RoleModelBinding[]
// PUT  /admin/role-bindings               RoleModelBinding[]
// POST /admin/providers/:provider/test    -> { ok, message }
export const SetProviderRequest = z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional().nullable() });
export const CreateModelRequest = AiModel.omit({ id: true, createdAt: true });
export const UpdateModelRequest = CreateModelRequest.partial();
export const SetRoleBindingsRequest = z.array(RoleModelBinding);

// ----------------------------- clients, orgs, github -----------------------
// GET/POST /clients ; GET/PATCH/DELETE /clients/:id
export const CreateClientRequest = z.object({ name: z.string().min(1), slug: z.string().regex(/^[a-z0-9-]+$/), description: z.string().optional() });
/** Membership routes (super admin only): GET /clients/:clientId/members, PUT /clients/:clientId/members/:userId, DELETE /clients/:clientId/members/:userId, GET /admin/memberships. */
export const SetClientMemberRequest = z.object({ role: ClientMemberRole.default('member') });
// GET  /clients/:clientId/orgs ; POST /clients/:clientId/orgs
export const CreateOrgRequest = z.object({
  label: z.string().min(1),
  kind: OrgKind,
  loginUrl: z.string().url().default('https://login.salesforce.com'),
  apiVersion: z.string().default('62.0'),
  protected: z.boolean().default(false),
  /** Consumer Key of the Connected App this org authorizes through. Omitted only when the server sets SF_CLIENT_ID as a fallback. */
  consumerKey: z.string().trim().min(1).optional(),
  /** Consumer Secret; omit for a PKCE-only app. Stored tenant-encrypted and never returned. */
  consumerSecret: z.string().optional(),
});
// GET  /orgs/:orgId/connect/start -> { url }   (Salesforce OAuth web-server flow w/ PKCE; redirect back to server)
// GET  /oauth/salesforce/callback (server-side)
// POST /orgs/:orgId/disconnect
// GET  /orgs/:orgId/status -> { status, identity }
// POST /orgs/:orgId/query  { soql, tooling? } -> QueryResult
export const QueryRequest = z.object({
  soql: z.string().min(1),
  tooling: z.boolean().default(false),
  limit: z.number().int().positive().max(2000).default(200),
});
export const QueryResponse = z.object({
  totalSize: z.number(),
  done: z.boolean(),
  records: z.array(z.record(z.string(), z.unknown())),
  columns: z.array(z.string()),
});
// GET  /orgs/:orgId/describe/global
// GET  /orgs/:orgId/describe/:sobject
// GET  /orgs/:orgId/metadata/types
// GET  /orgs/:orgId/metadata/list?type=Flow
// GET  /orgs/:orgId/metadata/read?type=Flow&fullName=My_Flow -> { xml, source }
// GET  /orgs/:orgId/resolve?sfOrgId=00D...  (extension: which registered org is this tab?)

// GET/PUT /clients/:clientId/github
export const SetGithubRepoRequest = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  defaultBranch: z.string().default('main'),
  sourceRoot: z.string().default('force-app/main/default'),
  docsRoot: z.string().default('docs/harness'),
  commitStrategy: GithubRepo.shape.commitStrategy,
  branchPrefix: z.string().default('harness/'),
  /** Fine-grained PAT or GitHub App installation token. Stored encrypted. */
  token: z.string().optional(),
});
// GET  /clients/:clientId/github/branches
// GET  /clients/:clientId/github/compare?base=main&head=harness/xyz -> CompareResponse
export const FileDiff = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullable(),
  metadataType: z.string().nullable(),
  fullName: z.string().nullable(),
});
export const CompareResponse = z.object({
  base: z.string(),
  head: z.string(),
  aheadBy: z.number(),
  behindBy: z.number(),
  files: z.array(FileDiff),
  url: z.string(),
});
// GET /clients/:clientId/github/commits?branch=...
// GET /clients/:clientId/github/file?path=...&ref=...

// ----------------------------- skills --------------------------------------
// GET /skills?clientId=&orgId= ; POST /skills ; PATCH /skills/:id ; DELETE /skills/:id
export const CreateSkillRequest = z.object({
  name: z.string().min(1),
  kind: SkillKind,
  scope: SkillScope,
  clientId: z.string().optional().nullable(),
  orgId: z.string().optional().nullable(),
  roles: z.array(AgentRole).default([]),
  content: z.string().min(1),
  enabled: z.boolean().default(true),
});
export const UpdateSkillRequest = CreateSkillRequest.partial();
// GET/PUT /admin/policy?clientId=  -> PolicyRules (global default merged with client override)
export const SetPolicyRequest = PolicyRules.partial();

// ----------------------------- projects & tasks ----------------------------
export const CreateProjectRequest = z.object({ clientId: z.string(), name: z.string().min(1), description: z.string().optional() });
export const CreateTaskRequest = z.object({
  projectId: z.string(),
  orgId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
});
export const UpdateTaskRequest = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: TaskStatus.optional(),
  assigneeId: z.string().nullable().optional(),
  orgId: z.string().nullable().optional(),
});

// ----------------------------- sessions ------------------------------------

// POST /sessions                -> Session (with no title/project/task, returns the caller's newest
//                                  idle session on that org that has no user message yet, if any)
export const CreateSessionRequest = z.object({
  orgId: z.string(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  title: z.string().optional(),
  uiMode: UiMode.default('visual'),
  pageContext: PageContext.optional(),
});
// GET  /sessions?mine=1&clientId=&status=   -> Session[]
// GET  /sessions/:id                        -> SessionDetail
// POST /sessions/:id/messages  { text, attachments? } -> 202 (starts/continues agent loop)
export const SendMessageRequest = z.object({
  text: z.string().min(1),
  attachments: z.array(z.object({ name: z.string(), mimeType: z.string(), dataBase64: z.string() })).optional(),
  /** Where the user is right now. Replaces the session's stored context when it has moved. */
  pageContext: PageContext.optional(),
});
// POST /sessions/:id/browser-capture — the panel answering a browser.request event
export const BrowserCaptureResponse = z.object({
  requestId: z.string(),
  console: z.array(ConsoleEntry).max(500).optional(),
  network: z.array(NetworkEntry).max(500).optional(),
  /** Entries dropped because the recorder's ring buffer wrapped, so the agent knows the window is partial. */
  dropped: z.number().int().min(0).default(0),
  /** Set when the panel could not capture at all (no Salesforce tab, recorder not injected). */
  unavailable: z.string().nullable().optional(),
});
export type BrowserCaptureResponse = z.infer<typeof BrowserCaptureResponse>;

// POST /sessions/:id/confirm   { confirmationId, optionId }
export const ConfirmRequest = z.object({ confirmationId: z.string(), optionId: z.string(), answerText: z.string().max(4000).optional() });
// POST /sessions/:id/cancel
// POST /sessions/:id/feedback  { helpful, note? }
// POST /sessions/:id/complete  -> Session (status 'completed'; 400 while running)
export const FeedbackRequest = z.object({ helpful: z.boolean(), note: z.string().max(2000).optional() });
// GET  /sessions/:id/events?after=<seq>   -> text/event-stream (SSE)
// GET  /sessions/:id/history?after=<seq>  -> SessionEvent[] (replay)
// GET  /sessions/:id/workspace            -> WorkspaceFile[]
// PUT  /sessions/:id/workspace/file       { path, content }  (pro mode manual edits)
// GET  /sessions/:id/deploys              -> DeployRun[]
// POST /sessions/:id/validate             -> DeployRun (checkOnly; manual trigger)
// POST /sessions/:id/deploy               -> requires prior successful validation; creates confirmation
// GET  /sessions/:id/docs                 -> DocEntry[]
// POST /sessions/:id/commit  { message?, createPullRequest? } -> confirmation flow
export const CommitRequest = z.object({ message: z.string().optional(), createPullRequest: z.boolean().optional() });

// GET  /sessions/:id/todos   -> TodoItem[]
// GET  /sessions/:id/notes   -> Note[]
// GET  /sessions/:id/snapshot -> SessionSnapshot (everything needed to cache the session locally / recover it)
// POST /sessions/:id/resume  -> 202 (restart a dead/interrupted session: orchestrator continues from persisted memory + todo list)
// GET  /orgs/:orgId/limits   -> OrgLimits (cached 60s)
// GET  /sessions/:id/permissions -> { command: string, grantedAt: string }[] (session-level "always allow")
// DELETE /sessions/:id/permissions/:command
export const SessionSnapshot = z.object({
  session: Session,
  events: z.array(z.unknown()),
  todos: z.array(TodoItem),
  notes: z.array(Note),
  workspace: z.array(WorkspaceFile),
  deploys: z.array(DeployRun),
  docs: z.array(DocEntry),
  pendingConfirmations: z.array(z.unknown()),
  lastSeq: z.number().int(),
  running: z.boolean(),
  snapshotAt: z.string(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export const SessionDetail = z.object({
  session: Session,
  org: SalesforceOrg,
  client: Client,
  project: Project.nullable(),
  task: Task.nullable(),
  workspace: z.array(WorkspaceFile),
  deploys: z.array(DeployRun),
  docs: z.array(DocEntry),
  lastSeq: z.number().int(),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

// ----------------------------- admin: observability ------------------------
// GET /admin/sessions?userId=&clientId=&from=&to=&helpful=  -> Session[] (all users)
// GET /admin/usage/summary?from=&to=&groupBy=user|client|model|role -> UsageSummary
export const UsageSummaryRow = z.object({
  key: z.string(),
  label: z.string(),
  sessions: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  costUsd: z.number(),
});
export const UsageSummary = z.object({ groupBy: z.string(), from: z.string(), to: z.string(), rows: z.array(UsageSummaryRow), totals: UsageSummaryRow });
// GET /admin/usage/records?sessionId=  -> UsageRecord[]
// GET /admin/audit?limit=  -> AuditEntry[]
export const AuditEntry = z.object({
  id: z.string(),
  at: z.string(),
  userId: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  details: z.unknown().nullable(),
  ip: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ----------------------------- health --------------------------------------
// GET /health -> { ok, version, setupRequired }
export const HealthResponse = z.object({ ok: z.boolean(), version: z.string(), setupRequired: z.boolean(), time: z.string() });

export type RegisterRequest = z.infer<typeof RegisterRequest>;
export type LoginRequest = z.infer<typeof LoginRequest>;
export type AuthResponse = z.infer<typeof AuthResponse>;
export type CreateOrgRequest = z.infer<typeof CreateOrgRequest>;
export type CreateClientRequest = z.infer<typeof CreateClientRequest>;
export type SetClientMemberRequest = z.infer<typeof SetClientMemberRequest>;
export type QueryRequest = z.infer<typeof QueryRequest>;
export type QueryResponse = z.infer<typeof QueryResponse>;
export type SetGithubRepoRequest = z.infer<typeof SetGithubRepoRequest>;
export type CompareResponse = z.infer<typeof CompareResponse>;
export type FileDiff = z.infer<typeof FileDiff>;
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;
export type ConfirmRequest = z.infer<typeof ConfirmRequest>;
export type FeedbackRequest = z.infer<typeof FeedbackRequest>;
export type UsageSummary = z.infer<typeof UsageSummary>;
export type CreateModelRequest = z.infer<typeof CreateModelRequest>;
export type SetProviderRequest = z.infer<typeof SetProviderRequest>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;
export type CommitRequest = z.infer<typeof CommitRequest>;
export type DeviceStartResponse = z.infer<typeof DeviceStartResponse>;
export { AiProvider, ProviderCredential, UsageRecord, DocEntry, Skill, PolicyRules, WorkspaceFile, DeployRun };
