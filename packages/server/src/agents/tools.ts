import type { AgentRole, PolicyRules, WorkspaceFile, Client, TodoItem } from '@sf-claws/shared';
import { inferComponentFromPath } from '@sf-claws/shared';
import type { AppContext } from '../app-context.js';
import type { OrgRow, SessionRow } from '../db/repos/index.js';
import type { LlmTool } from '../ai/types.js';
import type { SessionRuntime } from './runtime.js';
import { validateXml } from '../salesforce/metadata-xml.js';
import { DEFAULT_RESULT_LIMIT } from './budget.js';
import type { RepoStore } from '../knowledge/repo-store.js';
import { compileSafePattern } from '../knowledge/pattern-guard.js';
import { componentSubject, permissionRefusalText } from './policy.js';
import { classifyAnonymousApex } from './apex-classify.js';
import { sha256 } from '../lib/crypto.js';
import { canonicalRole, DELEGATABLE_ROLES, READ_ONLY_ROLES } from './built-in/index.js';
import { AGENT_PROMPT } from './tool-prompts.js';
import { TASK_TOOLS } from './task-tools.js';
import { SEARCH_TOOLS } from './search-tools.js';
import { WEB_TOOLS } from './web-tools.js';

/**
 * The object a SOQL statement reads, for permission scoping. Anything the regex cannot name still
 * yields a subject, so a scoped rule fails closed on a query shape we did not anticipate.
 */
/** `sinceSeconds` as an absolute timestamp, so the panel filters against one fixed instant. */
function sinceIso(sinceSeconds?: number): string | null {
  return sinceSeconds ? new Date(Date.now() - sinceSeconds * 1000).toISOString() : null;
}

function soqlSubjects(soql: string): string[] {
  const m = /\bfrom\s+([A-Za-z0-9_.]+)/i.exec(soql);
  return [m ? m[1] : 'unknown'];
}

/** One wording for every tool that asks for a blast radius, so the model is told the same thing everywhere. */
const IMPACT_DESCRIPTION = 'Who and what this affects, in plain language a business admin can judge — users, profiles, automations, record counts.';

export interface ToolContext {
  app: AppContext;
  runtime: SessionRuntime;
  session: SessionRow;
  org: OrgRow;
  client: Client;
  rules: PolicyRules;
  agent: { id: string; role: AgentRole; parentId: string | null };
  signal: AbortSignal;
  /** Original file contents fetched from the org during this session (path -> content). */
  originals: Map<string, string>;
  /** Set for researcher sub-agents: which knowledge repository they are scanning, and their budget. */
  research?: { sourceId: string; readBudget: { used: number; max: number } };
  conversation?: () => import('../ai/types.js').LlmMessage[];
}

/** The repository a researcher sub-agent was pointed at, with its warm snapshot. */
async function researchTarget(ctx: ToolContext) {
  if (!ctx.research) throw new Error('This tool is only available to a researcher investigating a repository.');
  const source = ctx.app.repos.knowledge.byId(ctx.research.sourceId);
  if (!source) throw new Error('The knowledge source for this investigation no longer exists.');
  return { source, snap: await ctx.app.knowledge.snapshotFor(source) };
}

export interface ToolResult {
  text: string;
  output?: unknown;
  ok?: boolean;
}
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  roles: AgentRole[] | 'all';
  /** Reads only — never changes the org, the workspace or session state. */
  readOnly: boolean;
  /**
   * Safe to run in parallel with other calls in the same model turn. Unsafe by default (fail
   * closed): two writes to one path race, and two gated commands would open competing
   * confirmation cards. May depend on the input — delegating to a read-only sub-agent is safe,
   * delegating to a builder is not.
   */
  concurrencySafe?: boolean | ((input: any, ctx?: ToolContext) => boolean);
  /** Irreversible from the user's point of view (deletes, deploys, real record changes). */
  destructive?: boolean;
  /** Per-call result ceiling in characters; larger output spills to an artifact handle. */
  maxResultChars?: number;
  /** Refuse while the session is waiting for plan approval (staging tools). */
  requiresApprovedPlan?: boolean;
  /**
   * Opt out of starting while the model is still streaming. A read-only, concurrency-safe tool
   * is eligible by default; set this on a "read" that spends real money (it starts a paid
   * sub-agent), because a message that fails mid-stream is thrown away and the spend is not.
   */
  earlyStart?: false;
  /**
   * What a user cancel does to a call already in flight. 'cancel' (default): the result is
   * discarded and the loop stops. 'block': the call runs to completion and its result is recorded
   * before the session is marked cancelled — a deploy, a commit or a record write must never be
   * left in an unknown state because someone clicked Stop.
   */
  interruptBehavior?: 'cancel' | 'block';
  run: (input: any, ctx: ToolContext) => Promise<ToolResult>;
}

/** Resolve a tool's concurrency safety for a specific call. Unknown tools are never safe. */
export function isConcurrencySafe(def: ToolDef | undefined, input: unknown, ctx?: ToolContext): boolean {
  if (!def) return false;
  const c = def.concurrencySafe;
  if (typeof c === 'function') {
    try {
      return !!c(input ?? {}, ctx);
    } catch {
      return false;
    }
  }
  return c === true;
}

/** Sub-agent roles that only read: delegating to one is safe beside other calls and needs no plan. */
export const READ_ONLY_SUBAGENT_ROLES = READ_ONLY_ROLES;

/** Per-call result ceiling for a tool. */
export function resultLimitFor(def: ToolDef | undefined): number {
  return def?.maxResultChars ?? DEFAULT_RESULT_LIMIT;
}

const ALL_ROLES: AgentRole[] = [
  'general',
  'explore',
  'plan',
  'verify',
  'orchestrator',
  'analyst',
  'metadata_builder',
  'flow_builder',
  'apex_builder',
  'reviewer',
  'doc_writer',
  'researcher',
  'summarizer',
];
const READERS: AgentRole[] = ['orchestrator', 'analyst', 'metadata_builder', 'flow_builder', 'apex_builder', 'reviewer', 'doc_writer'];
/** The researcher only sees knowledge tools — it must not touch the org or the workspace. */
const BUILDERS: AgentRole[] = ['metadata_builder', 'flow_builder', 'apex_builder'];
const MAX_TEXT = 40_000;
/** Longest line a grep will match against, bounding backtracking input. */
const MAX_GREP_LINE_CHARS = 500;

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s);
const json = (v: unknown, n = MAX_TEXT) => clip(JSON.stringify(v, null, 1), n);
/**
 * Full JSON, never clipped here: the budget layer (`budgetTurnResults`) applies the tool's
 * `maxResultChars` and spills the whole text to an artifact the agent can page back into. A tool
 * that truncates its own output throws the tail away before the budget layer ever sees it.
 */
const jsonFull = (v: unknown) => JSON.stringify(v, null, 1);
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/**
 * Stage a file in the session workspace: normalise the path, infer the metadata component,
 * validate XML, enforce policy, and fetch the org's current version once so the panel can show a
 * real diff. Shared by write_workspace_file and edit_workspace_file so both paths enforce the same
 * rules — an edit must never be a way around a policy check.
 */
export async function stageWorkspaceFile(
  ctx: ToolContext,
  input: { path: string; content: string; metadataType?: string | null; fullName?: string | null },
): Promise<ToolResult> {
  const path = normalizePath(input.path);
  if (!path || path.includes('..')) return { text: 'Invalid path', ok: false };
  const inferred = inferComponentFromPath(path);
  const metadataType = inferred?.metadataType ?? input.metadataType ?? null;
  const fullName = inferred?.fullName ?? input.fullName ?? null;
  const refusal = ctx.runtime.workspaceWriteRefusal(ctx.session.id, { path, metadataType, fullName });
  if (refusal) return { text: refusal, ok: false };
  if (path.endsWith('.xml')) {
    const err = validateXml(input.content);
    if (err) return { text: `XML is not well-formed: ${err}`, ok: false };
  }
  const violation = ctx.app.policy.checkComponent(ctx.rules, metadataType, fullName);
  if (violation) return { text: `POLICY VIOLATION (${violation.rule}): ${violation.message}`, ok: false };
  const existing = ctx.app.repos.workspace.get(ctx.session.id, path);
  let original = existing?.original ?? ctx.originals.get(path) ?? null;
  if (!existing && original === null && metadataType && fullName) {
    try {
      const files = await ctx.runtime.readFact(ctx.session.id, `metadata:${metadataType}:${fullName}`, () =>
        ctx.app.sf.readComponent(ctx.org.id, metadataType, fullName),
      );
      const match = files.find((f) => f.path === path);
      if (match) original = match.content;
      for (const f of files) ctx.originals.set(f.path, f.content);
    } catch (error) {
      return {
        text: `Cannot establish the original component: ${(error as Error).message}. Nothing staged; an authorization or transport failure is not evidence of absence.`,
        ok: false,
      };
    }
  }
  const action: WorkspaceFile['action'] = existing ? existing.action : original !== null ? 'modified' : 'created';
  const file: WorkspaceFile = { path, content: input.content, original, metadataType, fullName, action };
  const lateRefusal = ctx.runtime.workspaceWriteRefusal(ctx.session.id, file);
  if (lateRefusal) return { text: lateRefusal, ok: false };
  ctx.app.repos.workspace.upsert(ctx.session.id, file);
  ctx.runtime.noteWorkspaceChange(ctx.session.id, path);
  ctx.runtime.bus.emit(ctx.session.id, { type: 'workspace.file', path, action: existing ? 'modified' : action, metadataType, fullName });
  return {
    text: `Staged ${action}: ${path}${metadataType ? ` (${metadataType} ${fullName})` : ''}. Remember to validate_deployment.`,
    output: { path, action, metadataType, fullName },
  };
}

export const TOOLS: ToolDef[] = [
  ...TASK_TOOLS,
  ...SEARCH_TOOLS,
  ...WEB_TOOLS,
  {
    name: 'hydrate_context',
    readOnly: true,
    concurrencySafe: false,
    earlyStart: false,
    description:
      'Fetch one bounded second hydration pass for newly discovered API names (for example object Account or ApexClass ExistingClass). Persists verified evidence in the shared context bundle. At most two passes per user turn; never performs global discovery.',
    inputSchema: obj({ targets: { type: 'string' } }, ['targets']),
    roles: READERS,
    run: async (input, ctx) => ({ text: await ctx.runtime.hydrateContext(ctx.session.id, String(input.targets).slice(0, 4000)) }),
  },
  {
    name: 'consult_specialist',
    readOnly: false,
    requiresApprovedPlan: true,
    // Starts a paid sub-agent: never speculatively while the message is still streaming.
    earlyStart: false,
    // Safe in parallel only when the specialist inherits a read-only role; resolved at call time.
    concurrencySafe: (input, ctx) => {
      if (!ctx) return false;
      const agent = ctx.app.repos.customAgents.resolve(ctx.session.clientId, String(input?.specialist ?? ''));
      return !!agent && READ_ONLY_SUBAGENT_ROLES.has(agent.baseRole);
    },
    description:
      "Delegate to one of your agency's named specialists. Each one carries extra instructions written by your super admin for a specific domain. The list of available specialists, and when to use each, is in your instructions. Brief it the same way you would brief any sub-agent: what you are trying to achieve, what you already know, and what you need back.",
    inputSchema: obj(
      {
        specialist: { type: 'string', description: 'Specialist name from your instructions' },
        objective: { type: 'string' },
        context: { type: 'string', description: 'Facts already established (ids, API names, decisions)' },
      },
      ['specialist', 'objective'],
    ),
    roles: ['orchestrator'],
    run: async (input, ctx) => {
      const agent = ctx.app.repos.customAgents.resolve(ctx.session.clientId, String(input.specialist));
      if (!agent) {
        const available = ctx.app.repos.customAgents.forClient(ctx.session.clientId).map((a) => a.name);
        return {
          text: `No specialist called "${input.specialist}".${available.length ? ` Available: ${available.join(', ')}.` : ' None are configured for this client.'}`,
          ok: false,
        };
      }
      const r = await ctx.runtime.runSubagent(ctx.session.id, ctx.agent.id, agent.baseRole, String(input.objective), input.context, undefined, agent);
      return { text: r.report, output: { agentId: r.agentId, specialist: agent.name }, ok: r.ok };
    },
  },
  {
    name: 'search_product_docs',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 30_000,
    description:
      'Search the product documentation your agency has linked (guides, release notes, FAQs) for how a product is meant to work. Use this BEFORE scanning any source repository and before answering any question about product behaviour, configuration or setup steps.',
    inputSchema: obj({ query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']),
    roles: READERS,
    run: async (input, ctx) => {
      const hits = await ctx.app.knowledge.searchDocs(ctx.session.clientId, String(input.query), Number(input.limit ?? 8));
      if (!hits.length) {
        const text = ctx.app.knowledge.forClient(ctx.session.clientId).some((s) => s.kind === 'docs')
          ? `No product documentation matches "${input.query}". Try fewer or different keywords, or say plainly that it is not documented.`
          : 'No product documentation sources are linked for this client. Say so rather than answering from general knowledge.';
        // `message`, not an empty list: the panel renders output, and a bare [] reads as a broken step.
        return { text, output: { message: text } };
      }
      return {
        text: hits.map((h) => `### ${h.doc.title} (${h.doc.sourceName})\npath: ${h.doc.path}\n${h.snippet}`).join('\n\n'),
        output: hits.map((h) => ({ path: h.doc.path, title: h.doc.title, source: h.doc.sourceName })),
      };
    },
  },
  {
    name: 'read_product_doc',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60_000,
    description: 'Read a product documentation page in full, by the path returned from search_product_docs.',
    inputSchema: obj({ path: { type: 'string' } }, ['path']),
    roles: READERS,
    run: async (input, ctx) => {
      const doc = await ctx.app.knowledge.readDoc(ctx.session.clientId, String(input.path));
      if (!doc) return { text: `No documentation page at "${input.path}". Use search_product_docs to find the exact path.`, ok: false };
      return { text: `# ${doc.title}\n(source: ${doc.sourceName}, path: ${doc.path})\n\n${doc.body}`, output: { path: doc.path, title: doc.title } };
    },
  },
  {
    name: 'investigate_product_repo',
    readOnly: true,
    // Parallel research across repositories is the point; each researcher has its own snapshot.
    concurrencySafe: true,
    // A read from the org's point of view, but it starts a paid researcher: not before the
    // message that asked for it has actually finished streaming.
    earlyStart: false,
    description:
      'Ask a researcher sub-agent one specific question about a linked product source repository. Use it when the documentation does not answer the question and you need to know what the code actually does: where a behaviour is implemented, which configuration drives it, what a setting is called. Ask ONE precise question with an explicit extraction contract (exactly what to find and report). Include what you already know from the documentation — the researcher starts from what you tell it. Not for whole-repo summaries, and not for anything a documentation search answers.',
    inputSchema: obj(
      {
        repo: { type: 'string', description: 'Name of a linked repository source' },
        question: { type: 'string' },
        thoroughness: {
          type: 'string',
          enum: ['quick', 'medium', 'thorough'],
          description: '"quick": confirm one fact. "medium" (default): a normal trace. "thorough": exhaustive sweep, slower and more expensive.',
        },
      },
      ['repo', 'question'],
    ),
    roles: ['orchestrator', 'analyst'],
    run: async (input, ctx) => {
      const source = ctx.app.repos.knowledge.resolve(ctx.session.clientId, String(input.repo));
      if (!source)
        return {
          text: `No linked repository called "${input.repo}". Available: ${
            ctx.app.knowledge
              .forClient(ctx.session.clientId)
              .filter((s) => s.kind === 'repo')
              .map((s) => s.name)
              .join(', ') || 'none'
          }.`,
          ok: false,
        };
      const r = await ctx.runtime.runSubagent(
        ctx.session.id,
        ctx.agent.id,
        'researcher',
        String(input.question),
        `Repository: ${source.name} (${source.repoRef})\n${source.guidance}\nThoroughness: ${input.thoroughness ?? 'medium'}`,
        { sourceId: source.id, thoroughness: String(input.thoroughness ?? 'medium') },
      );
      return { text: r.report, output: { agentId: r.agentId, repo: source.name }, ok: r.ok };
    },
  },
  {
    name: 'repo_overview',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 40_000,
    description:
      'Map the repository you are researching: top-level directories, guide documents (README/CLAUDE.md) in full, and package manifests. ALWAYS call this first.',
    inputSchema: obj({}),
    roles: ['researcher'],
    run: async (_input, ctx) => {
      const { snap, source } = await researchTarget(ctx);
      const o = ctx.app.knowledge.repos_.overview(snap);
      const guides = o.guides.map((g) => `=== ${g.path} ===\n${g.content}`).join('\n\n');
      return {
        text: `Repository ${source.name} (${source.repoRef}) — ${snap.files.size} text files${snap.truncated ? ' (truncated at the size cap)' : ''}.\n\nTop-level directories: ${o.dirs.join(', ')}\nManifests: ${o.manifests.join(', ') || 'none'}\n\n${guides}`,
        output: { dirs: o.dirs, manifests: o.manifests },
      };
    },
  },
  {
    name: 'grep_repo',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60_000,
    description:
      'Search the repository with a regular expression. Modes: "content" (matching lines, default), "files" (paths only), "count" (matches per file). Use a glob to narrow by path, contextLines to see surrounding code.',
    inputSchema: obj(
      {
        pattern: { type: 'string', description: 'JavaScript regular expression, e.g. "class\\s+\\w+Service"' },
        glob: { type: 'string', description: 'Optional path filter, e.g. "**/*.cls"' },
        mode: { type: 'string', enum: ['content', 'files', 'count'] },
        contextLines: { type: 'integer', minimum: 0, maximum: 10 },
        headLimit: { type: 'integer', minimum: 1, maximum: 2000 },
        offset: { type: 'integer', minimum: 0 },
        multiline: { type: 'boolean', description: 'Let the pattern match across line boundaries' },
      },
      ['pattern'],
    ),
    roles: ['researcher'],
    run: async (input, ctx) => {
      const { snap } = await researchTarget(ctx);
      let r: ReturnType<RepoStore['grep']>;
      try {
        r = ctx.app.knowledge.repos_.grep(snap, input);
      } catch (e) {
        return { text: `Invalid pattern: ${(e as Error).message}`, ok: false };
      }
      if (!r.lines.length) return { text: `No match for /${input.pattern}/${input.glob ? ` in ${input.glob}` : ''}.`, output: { matches: 0 } };
      const more =
        r.nextOffset !== null
          ? `\n... [${r.totalMatches} matching lines in total; showing ${r.lines.length} from offset ${Number(input.offset ?? 0)} — continue with offset=${r.nextOffset}, or narrow the pattern]`
          : r.truncated
            ? '\n... [search stopped at the time budget — narrow the pattern or add a glob]'
            : '';
      return {
        text: r.lines.join('\n') + more,
        output: { filesMatched: r.filesMatched, totalMatches: r.totalMatches, nextOffset: r.nextOffset },
      };
    },
  },
  {
    name: 'read_repo_file',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60_000,
    description: 'Read a file from the repository with numbered lines. Use offset/limit to page a large file, or to jump to a grep hit (line N -> offset N-1).',
    inputSchema: obj({ path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, ['path']),
    roles: ['researcher'],
    run: async (input, ctx) => {
      const { snap } = await researchTarget(ctx);
      const budget = ctx.research?.readBudget;
      if (budget && budget.used >= budget.max)
        return {
          text: `Read budget exhausted (${budget.max} files for this investigation). Report what you have found with the evidence you already gathered.`,
          ok: false,
        };
      const r = ctx.app.knowledge.repos_.read(snap, String(input.path), Number(input.offset ?? 0), Number(input.limit ?? 400));
      if ('suggestions' in r)
        return { text: `No file at "${input.path}".${r.suggestions.length ? ` Did you mean: ${r.suggestions.join(', ')}?` : ''}`, ok: false };
      if (budget) budget.used++;
      return { text: `${input.path} (${r.totalLines} lines)\n${r.text}`, output: { path: input.path, totalLines: r.totalLines } };
    },
  },
  {
    name: 'find_repo_files',
    readOnly: true,
    concurrencySafe: true,
    description: 'Find files in the repository by glob pattern, or by a fragment of the path when you are unsure of the exact name.',
    inputSchema: obj({ pattern: { type: 'string', description: 'Glob (**/*.cls) or a path fragment (ComplianceService)' } }, ['pattern']),
    roles: ['researcher'],
    run: async (input, ctx) => {
      const { snap } = await researchTarget(ctx);
      const p = String(input.pattern);
      const hits = p.includes('*') ? ctx.app.knowledge.repos_.glob(snap, p) : ctx.app.knowledge.repos_.findFiles(snap, p);
      return { text: hits.length ? hits.join('\n') : `Nothing matches "${p}".`, output: hits };
    },
  },
  {
    name: 'load_skill',
    readOnly: true,
    concurrencySafe: true,
    description:
      'Read one of the agency skills listed as "available on demand" in your instructions. Load a skill when the work in front of you matches it — a playbook for the task you are doing, or knowledge about a package you are touching. Do not load them speculatively.',
    inputSchema: obj({ name: { type: 'string', description: 'Exact skill name as listed' } }, ['name']),
    roles: READERS,
    run: async (input, ctx) => {
      const skill = ctx.app.skills.byName(ctx.agent.role, ctx.session.clientId, ctx.org.id, String(input.name));
      if (!skill) return { text: `No skill named "${input.name}" applies to you. Use the exact name from the list in your instructions.`, ok: false };
      return ctx.runtime.readFact(ctx.session.id, `skill:${ctx.agent.role}:${skill.name}:${sha256(skill.content)}`, async () => ({
        text: `### [${skill.kind.toUpperCase()}] ${skill.name}\n${skill.content.trim()}`,
        output: { name: skill.name, kind: skill.kind },
      }));
    },
  },
  {
    name: 'read_tool_output',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60_000,
    description:
      'Read an earlier tool output that was too large to keep inline. Pass the artifact handle from the "[Output truncated ...]" note, with optional line offset/limit to page through it.',
    inputSchema: obj(
      {
        handle: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: '0-based line to start from' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Lines to return (default 400)' },
      },
      ['handle'],
    ),
    roles: READERS,
    run: async (input, ctx) => {
      const artifact = ctx.app.repos.artifacts.forSession(ctx.session.id, String(input.handle));
      if (!artifact) return { text: `No saved output with handle ${input.handle} in this session.`, ok: false };
      const lines = artifact.content.split('\n');
      const offset = Math.max(0, Number(input.offset ?? 0));
      const limit = Math.min(Number(input.limit ?? 400), 2000);
      const slice = lines.slice(offset, offset + limit);
      const more =
        offset + slice.length < lines.length
          ? `\n... [${lines.length - offset - slice.length} more lines — call again with offset=${offset + slice.length}]`
          : '';
      return {
        text: `${artifact.tool} output, lines ${offset + 1}-${offset + slice.length} of ${lines.length}:\n${slice.join('\n')}${more}`,
        output: { handle: artifact.id, totalLines: lines.length, offset },
      };
    },
  },
  {
    name: 'edit_workspace_file',
    readOnly: false,
    requiresApprovedPlan: true,
    description:
      'Replace an exact string in an already-staged workspace file. Cheaper and far less error-prone than resending a whole file for a small change: old_string must appear EXACTLY once unless replace_all is true. Prefer this over write_workspace_file when the file is already staged.',
    inputSchema: obj({ path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, replaceAll: { type: 'boolean' } }, [
      'path',
      'oldString',
      'newString',
    ]),
    roles: [...BUILDERS, 'orchestrator'],
    run: async (input, ctx) => {
      const path = normalizePath(input.path);
      const existing = ctx.app.repos.workspace.get(ctx.session.id, path);
      if (!existing) return { text: `Not staged: ${path}. Use write_workspace_file to create it first.`, ok: false };
      if (input.oldString === input.newString) return { text: 'oldString and newString are identical — nothing to do.', ok: false };
      const occurrences = countOccurrences(existing.content, input.oldString);
      if (occurrences === 0) return { text: `oldString was not found in ${path}. Read the file and match the exact text including indentation.`, ok: false };
      if (occurrences > 1 && !input.replaceAll)
        return {
          text: `oldString appears ${occurrences} times in ${path}. Include more surrounding context to make it unique, or pass replaceAll: true.`,
          ok: false,
        };
      const content = input.replaceAll
        ? existing.content.split(input.oldString).join(input.newString)
        : existing.content.replace(input.oldString, input.newString);
      return stageWorkspaceFile(ctx, { path, content, metadataType: existing.metadataType, fullName: existing.fullName });
    },
  },
  {
    name: 'glob_workspace',
    readOnly: true,
    concurrencySafe: true,
    description:
      'Find staged workspace files by glob pattern (** crosses directories, * within one segment, ? one character), e.g. "objects/**/fields/*.field-meta.xml".',
    inputSchema: obj({ pattern: { type: 'string' } }, ['pattern']),
    roles: READERS,
    run: async (input, ctx) => {
      const re = globToRegExp(String(input.pattern));
      const hits = ctx.app.repos.workspace.list(ctx.session.id).filter((f) => re.test(f.path));
      return {
        text: hits.length ? hits.map((f) => `${f.action.padEnd(8)} ${f.path}`).join('\n') : `No staged files match ${input.pattern}.`,
        output: hits.map((f) => f.path),
      };
    },
  },
  {
    name: 'grep_workspace',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60_000,
    description:
      'Search the content of staged workspace files with a regular expression. Output modes: "content" (matching lines, default), "files" (paths only), "count" (matches per file). Optionally restrict to a glob.',
    inputSchema: obj(
      {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        glob: { type: 'string', description: 'Optional path filter, e.g. "**/*.cls"' },
        mode: { type: 'string', enum: ['content', 'files', 'count'] },
        contextLines: { type: 'integer', minimum: 0, maximum: 10 },
        headLimit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max output lines (default 150)' },
      },
      ['pattern'],
    ),
    roles: READERS,
    run: async (input, ctx) => {
      let re: RegExp;
      try {
        // Same guard as the repository grep: a model-supplied pattern runs on the shared event
        // loop, so a backtracking blow-up would stall every other tenant's session.
        re = compileSafePattern(String(input.pattern), 'gm');
      } catch (e) {
        return { text: (e as Error).message, ok: false };
      }
      const pathFilter = input.glob ? globToRegExp(String(input.glob)) : null;
      const files = ctx.app.repos.workspace.list(ctx.session.id).filter((f) => !pathFilter || pathFilter.test(f.path));
      const mode = input.mode ?? 'content';
      const headLimit = Math.min(Number(input.headLimit ?? 150), 1000);
      const contextLines = Math.min(Number(input.contextLines ?? 0), 10);
      const out: string[] = [];
      let matched = 0;
      for (const f of files) {
        const lines = f.content.split('\n');
        const hits: number[] = [];
        lines.forEach((line, i) => {
          re.lastIndex = 0;
          if (re.test(line.slice(0, MAX_GREP_LINE_CHARS))) hits.push(i);
        });
        if (!hits.length) continue;
        matched++;
        if (mode === 'files') {
          out.push(f.path);
          continue;
        }
        if (mode === 'count') {
          out.push(`${f.path}: ${hits.length}`);
          continue;
        }
        for (const i of hits) {
          const from = Math.max(0, i - contextLines);
          const to = Math.min(lines.length - 1, i + contextLines);
          for (let n = from; n <= to; n++) out.push(`${f.path}:${n + 1}${n === i ? ':' : '-'} ${lines[n]}`);
          if (out.length >= headLimit) break;
        }
        if (out.length >= headLimit) break;
      }
      if (!out.length) return { text: `No staged file matches /${input.pattern}/.`, output: { matches: 0 } };
      const truncated = out.length > headLimit ? `\n... [output truncated at ${headLimit} lines — narrow the pattern or raise headLimit]` : '';
      return { text: out.slice(0, headLimit).join('\n') + truncated, output: { files: matched, lines: Math.min(out.length, headLimit) } };
    },
  },
  {
    name: 'ask_user',
    readOnly: false,
    description:
      'Ask the user a question with concrete options and wait for their answer. Use this instead of ending your turn with a question in prose: the user sees real buttons and the session stays alive. Good for genuine forks (which object? create new or extend existing?) — not for confirming work you should simply do. Put the option you recommend first. The user can always answer freely instead of picking.',
    inputSchema: obj(
      {
        question: {
          type: 'string',
          description:
            'The complete question, ending with a question mark. Plain language, no jargon; the user is a Salesforce admin, not a developer. One question per call — ask the next one after the answer.',
        },
        header: { type: 'string', description: 'Optional short chip shown above the question, at most 12 characters, e.g. "Object" or "Scope"' },
        options: {
          type: 'array',
          description:
            'Two to four mutually exclusive choices. Put the one you recommend first and suffix its label with " (Recommended)". Do not add an "Other" or "Let me type" option: the user can always answer freely instead of picking.',
          items: obj(
            {
              id: { type: 'string', description: 'Stable id, e.g. "extend" or "new"' },
              label: { type: 'string', description: 'Short, 1-5 words' },
              detail: { type: 'string', description: 'One line explaining the consequence of this choice' },
            },
            ['id', 'label'],
          ),
        },
        allowFreeText: { type: 'boolean', description: 'Default true — the user can type their own answer' },
      },
      ['question', 'options'],
    ),
    roles: ['orchestrator'],
    run: async (input, ctx) => ctx.runtime.askUser(ctx.session.id, input.question, input.options ?? [], input.allowFreeText !== false, input.header),
  },
  {
    name: 'submit_plan',
    readOnly: false,
    description:
      'Submit your implementation plan for the user to approve before you build anything. Required for non-trivial work: investigate first, then describe in Salesforce terms (objects, fields, flows, page layouts, permissions) what you will change, how you will validate it, what the risks are and what the user will notice afterwards. No XML, no code. Do not restate the request; no prose paragraphs; at most 40 lines. Blocks until the user approves or asks for changes; if they ask for changes, revise and submit again.',
    inputSchema: obj(
      {
        summary: { type: 'string', description: 'One or two sentences: what you are going to do' },
        markdown: {
          type: 'string',
          description: 'The plan itself: objective, the components you will change, validation approach, risks, what changes for end users',
        },
        impact: { type: 'string', description: IMPACT_DESCRIPTION },
      },
      ['summary', 'markdown', 'impact'],
    ),
    roles: ['orchestrator'],
    run: async (input, ctx) => ctx.runtime.submitPlan(ctx.session.id, input.summary, input.markdown, input.impact),
  },
  {
    name: 'soql_query',
    readOnly: true,
    concurrencySafe: true,
    description: 'Run a SOQL query against the org (REST API, or Tooling API when tooling=true). Returns records as JSON. Use explicit field lists and LIMIT.',
    inputSchema: obj(
      {
        soql: { type: 'string' },
        tooling: { type: 'boolean', description: 'Use the Tooling API (ApexLog, Flow, EntityDefinition, ...)' },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      ['soql'],
    ),
    roles: READERS,
    run: async (input, ctx) => {
      if (input.tooling) {
        const decision = ctx.app.policy.checkCommand(ctx.rules, 'soql_query_tooling', soqlSubjects(input.soql));
        if (decision.effect !== 'allow') return { text: permissionRefusalText('soql_query_tooling', decision), ok: false };
      }
      const r = await ctx.app.sf.query(ctx.org.id, input.soql, { tooling: !!input.tooling, limit: input.limit ?? 200 });
      return { text: `totalSize=${r.totalSize} returned=${r.records.length}\n${jsonFull(r.records)}`, output: r };
    },
  },
  {
    name: 'describe_sobject',
    readOnly: true,
    concurrencySafe: true,
    description:
      'Describe an object: its fields (API name, label, type, picklist values, references). Compact by default; pass include to also get recordTypeInfos and/or childRelationships.',
    inputSchema: obj(
      {
        sobject: { type: 'string' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['recordTypeInfos', 'childRelationships'] },
          description: 'Extra sections to include; omitted by default because they are large and rarely needed',
        },
      },
      ['sobject'],
    ),
    roles: READERS,
    run: async (input, ctx) => {
      const d: any = await ctx.runtime.readFact(ctx.session.id, `describe:${input.sobject}`, () => ctx.app.sf.describe(ctx.org.id, input.sobject));
      const include = new Set<string>(Array.isArray(input.include) ? input.include.map(String) : []);
      // Compact means compact: no urls, no child relationships, no record type infos unless asked.
      // A wide standard object's full describe is hundreds of kilobytes of mostly noise.
      const compact: Record<string, unknown> = {
        name: d.name,
        label: d.label,
        keyPrefix: d.keyPrefix,
        custom: d.custom,
        queryable: d.queryable,
        createable: d.createable,
        updateable: d.updateable,
        deletable: d.deletable,
        recordTypeCount: d.recordTypeInfos?.length ?? 0,
        childRelationshipCount: d.childRelationships?.length ?? 0,
        fields: d.fields.map((f: any) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          length: f.length,
          custom: f.custom,
          nillable: f.nillable,
          referenceTo: f.referenceTo,
          picklistValues: f.picklistValues?.map((p: any) => p.value),
          calculatedFormula: f.calculatedFormula,
          inlineHelpText: f.inlineHelpText,
        })),
      };
      if (include.has('recordTypeInfos'))
        compact.recordTypeInfos = d.recordTypeInfos?.map((r: any) => ({
          name: r.name,
          developerName: r.developerName,
          recordTypeId: r.recordTypeId,
          active: r.active,
          defaultRecordTypeMapping: r.defaultRecordTypeMapping,
        }));
      if (include.has('childRelationships'))
        compact.childRelationships = d.childRelationships?.map((c: any) => ({
          childSObject: c.childSObject,
          field: c.field,
          relationshipName: c.relationshipName,
        }));
      return { text: jsonFull(compact), output: d };
    },
  },
  {
    name: 'list_sobjects',
    readOnly: true,
    concurrencySafe: true,
    description: 'List objects in the org (optionally filter by substring of API name or label).',
    inputSchema: obj({ filter: { type: 'string' } }),
    roles: READERS,
    run: async (input, ctx) => {
      let list = await ctx.runtime.readFact(ctx.session.id, 'sobjects', () => ctx.app.sf.describeGlobal(ctx.org.id));
      if (input.filter) {
        const f = String(input.filter).toLowerCase();
        list = list.filter((s) => s.name.toLowerCase().includes(f) || s.label.toLowerCase().includes(f));
      }
      return {
        text: json(
          list.map((s) => `${s.name} (${s.label})${s.custom ? ' custom' : ''}`),
          30_000,
        ),
        output: list,
      };
    },
  },
  {
    name: 'list_metadata_types',
    readOnly: true,
    concurrencySafe: true,
    description: 'List metadata types supported by the org (Metadata API describe).',
    inputSchema: obj({}),
    roles: READERS,
    run: async (_input, ctx) => {
      const r = await ctx.runtime.readFact(ctx.session.id, 'metadata-types', () => ctx.app.sf.describeMetadata(ctx.org.id));
      return { text: r.map((t) => t.xmlName).join(', '), output: r };
    },
  },
  {
    name: 'list_metadata',
    readOnly: true,
    concurrencySafe: true,
    description:
      'List components of a metadata type (e.g. Flow, Layout, FlexiPage, PermissionSet, ApexClass, CustomObject, ValidationRule). Returns fullName and last modified info.',
    inputSchema: obj({ type: { type: 'string' }, folder: { type: 'string' } }, ['type']),
    roles: READERS,
    run: async (input, ctx) => {
      const r = await ctx.runtime.readFact(ctx.session.id, `metadata-list:${input.type}:${input.folder ?? ''}`, () =>
        ctx.app.sf.listMetadata(ctx.org.id, input.type, input.folder),
      );
      return {
        text: jsonFull(
          r.map((c) => ({
            fullName: c.fullName,
            lastModifiedByName: c.lastModifiedByName,
            lastModifiedDate: c.lastModifiedDate,
            namespacePrefix: c.namespacePrefix,
          })),
        ),
        output: r,
      };
    },
  },
  {
    name: 'read_metadata',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60_000,
    description:
      'Retrieve a component from the org as SFDX source-format file(s) (XML). Use before modifying anything. For fields use type CustomField and fullName Object.Field__c; for objects type CustomObject (returns object + all children).',
    inputSchema: obj({ type: { type: 'string' }, fullName: { type: 'string' } }, ['type', 'fullName']),
    roles: READERS,
    run: async (input, ctx) => {
      const files = await ctx.runtime.readFact(ctx.session.id, `metadata:${input.type}:${input.fullName}`, () =>
        ctx.app.sf.readComponent(ctx.org.id, input.type, input.fullName),
      );
      for (const f of files) ctx.originals.set(f.path, f.content);
      if (!files.length) return { text: `No files returned for ${input.type} ${input.fullName} (component may not exist).`, output: [] };
      return {
        text: files.map((f) => `=== ${f.path} ===\n${f.content}`).join('\n\n'),
        output: files.map((f) => ({
          path: f.path,
          size: f.content.length,
          metadataType: input.type,
          fullName: input.fullName,
          content: f.content.length < 200_000 ? f.content : undefined,
        })),
      };
    },
  },
  {
    name: 'get_apex_logs',
    readOnly: true,
    concurrencySafe: true,
    description: 'List recent debug logs (ApexLog) in the org.',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    roles: ['orchestrator', 'analyst', 'apex_builder'],
    run: async (input, ctx) => {
      const r = await ctx.app.sf.recentApexLogs(ctx.org.id, input.limit ?? 20);
      return { text: json(r), output: { columns: ['Id', 'LogUser.Name', 'Operation', 'Status', 'StartTime', 'LogLength'], records: r } };
    },
  },
  {
    name: 'get_apex_log_body',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 60_000,
    description: 'Read the body of a debug log (truncated to 60k chars). Look for EXCEPTION_THROWN, FATAL_ERROR, VALIDATION_RULE, FLOW_ELEMENT_ERROR lines.',
    inputSchema: obj({ logId: { type: 'string' } }, ['logId']),
    roles: ['orchestrator', 'analyst', 'apex_builder'],
    run: async (input, ctx) => {
      const body = await ctx.app.sf.apexLogBody(ctx.org.id, input.logId);
      return { text: body, output: { logId: input.logId, body } };
    },
  },
  {
    name: 'flow_versions',
    readOnly: true,
    concurrencySafe: true,
    description: 'List versions of a flow (status, version number) by developer name.',
    inputSchema: obj({ developerName: { type: 'string' } }, ['developerName']),
    roles: READERS,
    run: async (input, ctx) => {
      const r = await ctx.app.sf.flowVersions(ctx.org.id, input.developerName);
      return { text: json(r), output: { columns: ['VersionNumber', 'Status', 'ProcessType', 'LastModifiedDate'], records: r } };
    },
  },
  {
    name: 'list_installed_packages',
    readOnly: true,
    concurrencySafe: true,
    description:
      'List managed and unlocked packages installed in the org, with version and namespace. Ground "which 3rd-party product and version is this" in what the org actually reports, not what a client record claims.',
    inputSchema: obj({}),
    roles: READERS,
    run: async (_input, ctx) => {
      const r = await ctx.app.sf.listInstalledPackages(ctx.org.id);
      if (!r.length) return { text: 'No installed packages (managed or unlocked) found in this org.', output: [] };
      return {
        text: r.map((p) => `${p.name}${p.namespace ? ` (${p.namespace}__)` : ''} v${p.version}${p.versionName ? ` "${p.versionName}"` : ''}`).join('\n'),
        output: r,
      };
    },
  },
  {
    name: 'list_folders',
    readOnly: true,
    concurrencySafe: true,
    description:
      'List folders for in-folder metadata (Report, Dashboard, EmailTemplate, Document), needed before list_metadata can enumerate items inside one.',
    inputSchema: obj({ type: { type: 'string', enum: ['Report', 'Dashboard', 'EmailTemplate', 'Document'] } }, ['type']),
    roles: READERS,
    run: async (input, ctx) => {
      const r = await ctx.app.sf.listFolders(ctx.org.id, input.type);
      if (!r.length) return { text: `No ${input.type} folders found.`, output: [] };
      return { text: r.map((f) => f.fullName).join('\n'), output: r };
    },
  },
  {
    name: 'component_dependencies',
    readOnly: true,
    concurrencySafe: true,
    description:
      'What references a component (MetadataComponentDependency), so you know what breaks before staging a delete_component. Some orgs do not expose this API; the result says so rather than implying nothing depends on it.',
    inputSchema: obj({ type: { type: 'string' }, fullName: { type: 'string' } }, ['type', 'fullName']),
    roles: READERS,
    run: async (input, ctx) => {
      const r = await ctx.app.sf.componentDependencies(ctx.org.id, input.type, input.fullName);
      if (!r.available) return { text: r.note ?? 'Dependency lookup is not available in this org.', output: r };
      if (!r.dependents.length) return { text: `No dependents found for ${input.type} ${input.fullName}.`, output: r };
      return { text: r.dependents.map((d) => `${d.type} ${d.name}`).join('\n'), output: r };
    },
  },
  {
    name: 'set_trace_flag',
    readOnly: false,
    interruptBehavior: 'block',
    description:
      'Make sure Apex debug logs are being captured for a user for the next N minutes (creates/extends a TraceFlag and a DebugLevel). ALLOW-LISTED COMMAND. Ask the user to reproduce the issue after this returns, then use get_apex_logs.',
    inputSchema: obj(
      {
        userId: { type: 'string', description: 'Traced user id; omit to trace the integration user running this session' },
        minutes: { type: 'integer', minimum: 1, maximum: 1440 },
        reason: { type: 'string', description: 'Plain-language explanation for the user: why logs are needed and for whom' },
        impact: { type: 'string', description: IMPACT_DESCRIPTION },
      },
      ['minutes', 'reason', 'impact'],
    ),
    roles: ['orchestrator', 'analyst', 'apex_builder'],
    run: async (input, ctx) => {
      const refused = await ctx.runtime.gate({
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        command: 'set_trace_flag',
        reason: input.reason,
        impact: input.impact,
        input: { userId: input.userId ?? 'self', minutes: input.minutes },
        title: 'Turn on Apex debug logging?',
        subjects: [input.userId ?? 'self'],
      });
      if (refused) return { text: refused, ok: false };
      const r = await ctx.app.sf.ensureTraceFlag(ctx.org.id, { userId: input.userId, minutes: input.minutes });
      return {
        text: `Debug logging ${r.created ? 'enabled' : 'extended'} for user ${r.userId} until ${r.expirationDate}. Ask the user to reproduce the issue, then call get_apex_logs.`,
        output: r,
      };
    },
  },
  {
    name: 'flow_set_active_version',
    readOnly: false,
    destructive: true,
    interruptBehavior: 'block',
    description:
      'Activate a specific version of a Flow, or deactivate the Flow entirely (versionNumber: null). ALLOW-LISTED COMMAND: this changes live automation immediately, with no validate/deploy step in between.',
    inputSchema: obj(
      {
        developerName: { type: 'string' },
        versionNumber: { type: ['integer', 'null'], description: 'Version to activate, or null to deactivate the flow' },
        reason: { type: 'string', description: 'Plain-language explanation for the user: what this changes and why' },
        impact: { type: 'string', description: IMPACT_DESCRIPTION },
      },
      ['developerName', 'reason', 'impact'],
    ),
    roles: ['orchestrator', 'flow_builder'],
    run: async (input, ctx) => {
      const refused = await ctx.runtime.gate({
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        command: 'flow_set_active_version',
        reason: input.reason,
        impact: input.impact,
        input: { developerName: input.developerName, versionNumber: input.versionNumber ?? null },
        title:
          input.versionNumber == null ? `Deactivate flow "${input.developerName}"?` : `Activate version ${input.versionNumber} of "${input.developerName}"?`,
        subjects: [input.developerName],
      });
      if (refused) return { text: refused, ok: false };
      const r = await ctx.app.sf.flowSetActiveVersion(ctx.org.id, input.developerName, input.versionNumber ?? null);
      return {
        text:
          r.activeVersionNumber == null
            ? `Flow "${input.developerName}" is now deactivated.`
            : `Flow "${input.developerName}" version ${r.activeVersionNumber} is now active.`,
        output: r,
      };
    },
  },
  {
    name: 'search_memory',
    readOnly: true,
    concurrencySafe: true,
    description: "Search this org's documentation from previous sessions (long-term memory): decisions, components created, known issues.",
    inputSchema: obj({ query: { type: 'string' } }, ['query']),
    roles: READERS,
    run: async (input, ctx) => {
      const docs = ctx.app.repos.docs.search(ctx.org.id, input.query, 6);
      if (!docs.length) return { text: 'No documentation found for this org yet.', output: [] };
      return {
        text: docs.map((d) => `## ${d.title} (${d.createdAt.slice(0, 10)})\n${d.markdown}`).join('\n\n'),
        output: docs.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt, summary: d.summary, path: d.path })),
      };
    },
  },
  {
    name: 'list_workspace',
    readOnly: true,
    concurrencySafe: true,
    description: 'List files staged in the session workspace (changes not yet deployed).',
    inputSchema: obj({}),
    roles: READERS,
    run: async (_input, ctx) => {
      const files = ctx.app.repos.workspace.list(ctx.session.id);
      return {
        text: files.length
          ? files.map((f) => `${f.action.padEnd(8)} ${f.path}${f.metadataType ? ` (${f.metadataType} ${f.fullName})` : ''}`).join('\n')
          : 'Workspace is empty.',
        output: files.map(({ content: _c, original: _o, ...rest }) => rest),
      };
    },
  },
  {
    name: 'read_workspace_file',
    readOnly: true,
    concurrencySafe: true,
    maxResultChars: 80_000,
    description: 'Read a staged workspace file.',
    inputSchema: obj({ path: { type: 'string' } }, ['path']),
    roles: READERS,
    run: async (input, ctx) => {
      const f = ctx.app.repos.workspace.get(ctx.session.id, input.path);
      if (!f) return { text: `Not staged: ${input.path}`, ok: false };
      return { text: f.content, output: { path: f.path, metadataType: f.metadataType, fullName: f.fullName, action: f.action } };
    },
  },
  {
    name: 'write_workspace_file',
    readOnly: false,
    requiresApprovedPlan: true,
    description:
      'Create or update a file in the session workspace using an SFDX source-format path relative to the source root (e.g. objects/Account/fields/X__c.field-meta.xml, flows/X.flow-meta.xml, classes/X.cls, classes/X.cls-meta.xml, lwc/cmp/cmp.js). XML is validated for well-formedness. Nothing is deployed by this tool.',
    inputSchema: obj(
      {
        path: { type: 'string' },
        content: { type: 'string' },
        metadataType: { type: 'string', description: 'Override inferred type (rarely needed)' },
        fullName: { type: 'string' },
      },
      ['path', 'content'],
    ),
    roles: [...BUILDERS, 'orchestrator'],
    run: async (input, ctx) =>
      stageWorkspaceFile(ctx, { path: input.path, content: input.content, metadataType: input.metadataType, fullName: input.fullName }),
  },
  {
    name: 'delete_workspace_file',
    readOnly: false,
    requiresApprovedPlan: true,
    description: 'Remove a file from the workspace (unstage). Does not delete anything in the org.',
    inputSchema: obj({ path: { type: 'string' } }, ['path']),
    roles: [...BUILDERS, 'orchestrator'],
    run: async (input, ctx) => {
      const path = normalizePath(input.path);
      const existing = ctx.app.repos.workspace.get(ctx.session.id, path);
      const refusal = ctx.runtime.workspaceWriteRefusal(ctx.session.id, existing ?? { path, metadataType: null, fullName: null });
      if (refusal) return { text: refusal, ok: false };
      ctx.app.repos.workspace.remove(ctx.session.id, path);
      ctx.runtime.noteWorkspaceChange(ctx.session.id, path);
      ctx.runtime.bus.emit(ctx.session.id, { type: 'workspace.file', path, action: 'deleted', metadataType: null, fullName: null });
      return { text: `Unstaged ${path}` };
    },
  },
  {
    name: 'delete_component',
    readOnly: false,
    destructive: true,
    requiresApprovedPlan: true,
    description: 'Stage the DELETION of a component in the org (destructive change). Use sparingly; the user must confirm at deploy time.',
    inputSchema: obj({ type: { type: 'string' }, fullName: { type: 'string' } }, ['type', 'fullName']),
    roles: [...BUILDERS, 'orchestrator'],
    run: async (input, ctx) => {
      const violation = ctx.app.policy.checkComponent(ctx.rules, input.type, input.fullName);
      if (violation) return { text: `POLICY VIOLATION (${violation.rule}): ${violation.message}`, ok: false };
      const decision = ctx.app.policy.checkCommand(ctx.rules, 'delete_component', [componentSubject(input.type, input.fullName)]);
      if (decision.effect !== 'allow') return { text: permissionRefusalText('delete_component', decision), ok: false };
      const path = `__destructive__/${input.type}/${input.fullName}`;
      const refusal = ctx.runtime.workspaceWriteRefusal(ctx.session.id, { path, metadataType: input.type, fullName: input.fullName });
      if (refusal) return { text: refusal, ok: false };
      ctx.app.repos.workspace.upsert(ctx.session.id, {
        path,
        content: '',
        original: null,
        metadataType: input.type,
        fullName: input.fullName,
        action: 'deleted',
      });
      ctx.runtime.bus.emit(ctx.session.id, { type: 'workspace.file', path, action: 'deleted', metadataType: input.type, fullName: input.fullName });
      ctx.runtime.noteWorkspaceChange(ctx.session.id, path);
      return { text: `Staged deletion of ${input.type} ${input.fullName}.` };
    },
  },
  {
    name: 'validate_deployment',
    readOnly: false,
    interruptBehavior: 'block',
    description:
      'Check staged files against the org without saving them. Optional paths compile a dependency-expanded slice, which does not authorize deployment. Repair reported roots only; unchanged failed payloads and two no-progress compiles are blocked. Full validation with tests is required before deployment.',
    inputSchema: obj({
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional staged paths for an early slice compile' },
      testLevel: { type: 'string', enum: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'] },
      runTests: { type: 'array', items: { type: 'string' }, description: 'Test classes for RunSpecifiedTests' },
    }),
    roles: [...BUILDERS, 'orchestrator', 'reviewer'],
    run: async (input, ctx) => {
      const run = await ctx.runtime.validate(ctx.session.id, {
        testLevel: input.testLevel,
        runTests: input.runTests,
        agentId: ctx.agent.id,
        paths: input.paths,
      });
      const ok = run.status === 'succeeded';
      const text = ok
        ? `VALIDATION OK: ${run.componentsTotal} components, ${run.testsTotal} tests (${run.testsFailed} failed), coverage ${run.codeCoverage ?? 'n/a'}%.`
        : `VALIDATION FAILED (attempt ${run.attempt}): ${run.componentsFailed} component failures, ${run.testsFailed} test failures.\n${run.failures.map((f) => `- [${f.componentType ?? '?'}] ${f.fullName ?? f.fileName ?? ''}${f.lineNumber ? ` line ${f.lineNumber}` : ''}: ${f.problem}`).join('\n')}`;
      return { text: `${run.scope === 'slice' ? 'SLICE COMPILE ONLY — full validation still required.\n' : ''}${text}`, output: run, ok };
    },
  },
  {
    name: 'run_apex_tests',
    readOnly: false,
    interruptBehavior: 'block',
    description: 'Run Apex test classes that already exist in the org (not the workspace) and return results.',
    inputSchema: obj(
      { classNames: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' }, impact: { type: 'string', description: IMPACT_DESCRIPTION } },
      ['classNames', 'impact'],
    ),
    roles: ['orchestrator', 'analyst', 'apex_builder', 'reviewer'],
    run: async (input, ctx) => {
      const refused = await ctx.runtime.gate({
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        command: 'run_apex_tests',
        reason: input.reason ?? 'Run existing Apex tests to verify current behaviour in the org.',
        impact: input.impact,
        input: { classNames: input.classNames },
        title: 'Run Apex tests in the org?',
        subjects: input.classNames,
      });
      if (refused) return { text: refused, ok: false };
      const r = await ctx.app.sf.runTests(ctx.org.id, input.classNames);
      return { text: json(r), output: { columns: ['className', 'method', 'outcome', 'message'], records: r } };
    },
  },
  {
    name: 'execute_anonymous_apex',
    readOnly: false,
    interruptBehavior: 'block',
    destructive: true,
    description:
      'Execute anonymous Apex in the org. ALLOW-LISTED COMMAND: the user sees your "reason" and the exact Apex and must approve before it runs. Use for diagnostics, one-off data fixes (if policy allows), scheduling jobs, etc. Prefer read-only SOQL when possible.',
    inputSchema: obj(
      {
        apex: { type: 'string' },
        reason: { type: 'string', description: 'Plain-language explanation for the user: what this Apex does and why it is needed' },
        impact: { type: 'string', description: IMPACT_DESCRIPTION },
      },
      ['apex', 'reason', 'impact'],
    ),
    roles: ['orchestrator', 'analyst', 'apex_builder'],
    run: async (input, ctx) => {
      // Fails closed: only queries, locals and System.debug are read-only; a call into any class
      // the classifier does not know counts as mutating. See apex-classify.ts.
      const classified = classifyAnonymousApex(String(input.apex ?? ''));
      const mutates = classified.effect === 'mutating';
      if (mutates) {
        const v = ctx.app.policy.checkDataChange(ctx.rules);
        if (v) return { text: `POLICY VIOLATION (${v.rule}): ${v.message}`, ok: false };
      }
      const refused = await ctx.runtime.gate({
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        command: 'execute_anonymous_apex',
        reason: input.reason,
        impact: input.impact,
        input: { apex: input.apex, mutatesData: mutates, classifiedBecause: classified.reason },
        title: mutates ? 'Run Apex that changes data?' : 'Run anonymous Apex?',
        // Anonymous Apex has no component to name, so the subject is the only distinction that
        // matters to an admin: does this statement change data or only read it?
        subjects: [mutates ? 'mutating' : 'read-only'],
      });
      if (refused) return { text: refused, ok: false };
      const r = await ctx.app.sf.executeAnonymous(ctx.org.id, input.apex);
      return { text: json(r), output: r, ok: r.success };
    },
  },
  {
    name: 'create_record',
    readOnly: false,
    interruptBehavior: 'block',
    destructive: true,
    description: 'Create a record. ALLOW-LISTED COMMAND (user approves after reading your reason). Only when policy allows data modification.',
    inputSchema: obj(
      {
        sobject: { type: 'string' },
        fields: { type: 'object', additionalProperties: true },
        reason: { type: 'string' },
        impact: { type: 'string', description: IMPACT_DESCRIPTION },
      },
      ['sobject', 'fields', 'reason', 'impact'],
    ),
    // Record changes belong to the lead agent. The analyst's own prompt says it never changes
    // anything, and a specialist an admin defines on the analyst base role inherits whatever this
    // list grants — a role described as read-only must actually be read-only.
    roles: ['orchestrator'],
    run: async (input, ctx) => {
      const v = ctx.app.policy.checkDataChange(ctx.rules);
      if (v) return { text: `POLICY VIOLATION: ${v.message}`, ok: false };
      const refused = await ctx.runtime.gate({
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        command: 'create_record',
        reason: input.reason,
        impact: input.impact,
        input: { sobject: input.sobject, fields: input.fields },
        title: `Create a ${input.sobject} record?`,
        subjects: [input.sobject],
      });
      if (refused) return { text: refused, ok: false };
      const r = await ctx.app.sf.createRecord(ctx.org.id, input.sobject, input.fields);
      return { text: `Created ${input.sobject} ${r.id}`, output: r };
    },
  },
  {
    name: 'update_record',
    readOnly: false,
    interruptBehavior: 'block',
    destructive: true,
    description: 'Update a record. ALLOW-LISTED COMMAND (user approves after reading your reason). Only when policy allows data modification.',
    inputSchema: obj(
      {
        sobject: { type: 'string' },
        id: { type: 'string' },
        fields: { type: 'object', additionalProperties: true },
        reason: { type: 'string' },
        impact: { type: 'string', description: IMPACT_DESCRIPTION },
      },
      ['sobject', 'id', 'fields', 'reason', 'impact'],
    ),
    roles: ['orchestrator'],
    run: async (input, ctx) => {
      const v = ctx.app.policy.checkDataChange(ctx.rules);
      if (v) return { text: `POLICY VIOLATION: ${v.message}`, ok: false };
      const refused = await ctx.runtime.gate({
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        command: 'update_record',
        reason: input.reason,
        impact: input.impact,
        input: { sobject: input.sobject, id: input.id, fields: input.fields },
        title: `Update ${input.sobject} ${input.id}?`,
        subjects: [input.sobject],
      });
      if (refused) return { text: refused, ok: false };
      await ctx.app.sf.updateRecord(ctx.org.id, input.sobject, input.id, input.fields);
      return { text: `Updated ${input.sobject} ${input.id}` };
    },
  },
  {
    name: 'delete_record',
    readOnly: false,
    interruptBehavior: 'block',
    destructive: true,
    description: 'Delete a record. ALLOW-LISTED COMMAND (user approves after reading your reason). Only when policy allows data modification.',
    inputSchema: obj(
      { sobject: { type: 'string' }, id: { type: 'string' }, reason: { type: 'string' }, impact: { type: 'string', description: IMPACT_DESCRIPTION } },
      ['sobject', 'id', 'reason', 'impact'],
    ),
    roles: ['orchestrator'],
    run: async (input, ctx) => {
      const v = ctx.app.policy.checkDataChange(ctx.rules);
      if (v) return { text: `POLICY VIOLATION: ${v.message}`, ok: false };
      const refused = await ctx.runtime.gate({
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        command: 'delete_record',
        reason: input.reason,
        impact: input.impact,
        input: { sobject: input.sobject, id: input.id },
        title: `Delete ${input.sobject} ${input.id}?`,
        subjects: [input.sobject],
      });
      if (refused) return { text: refused, ok: false };
      await ctx.app.sf.deleteRecord(ctx.org.id, input.sobject, input.id);
      return { text: `Deleted ${input.sobject} ${input.id}` };
    },
  },
  {
    name: 'todo_write',
    readOnly: false,
    description:
      'Create or update the session TODO list (the user sees it live). Send the FULL list every time (it replaces the previous one). Each item has `content` in the imperative ("Validate the field") and `activeForm` in the present continuous ("Validating the field"), shown while it is in progress. Keep exactly one item in_progress while working. Mark items completed as soon as they are done; never complete a blocked item — mark it blocked and add a new item describing the blocker. Add items when you discover work. Use it to plan before starting non-trivial tasks and to track progress to completion.',
    inputSchema: obj(
      {
        items: {
          type: 'array',
          items: obj(
            {
              id: { type: 'string', description: 'Stable id, e.g. t1' },
              content: { type: 'string', description: 'Imperative, e.g. "Validate the field"' },
              activeForm: { type: 'string', description: 'Present continuous, e.g. "Validating the field"; the panel shows it while the item is in_progress' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
            },
            ['id', 'content', 'status'],
          ),
        },
      },
      ['items'],
    ),
    roles: ['orchestrator'],
    run: async (input, ctx) => {
      if (ctx.app.repos.agentState.get(ctx.session.id).tasks.length)
        return { text: 'This session uses task_create/task_update. Update that task board instead of replacing the checklist with todo_write.', ok: false };
      const items: TodoItem[] = (input.items as any[]).map((t) => ({
        id: String(t.id),
        content: String(t.content),
        activeForm: t.activeForm,
        status: t.status,
        ownerAgentId: ctx.agent.id,
      }));
      ctx.app.repos.todos.set(ctx.session.id, items, ctx.agent.id);
      ctx.runtime.bus.emit(ctx.session.id, { type: 'todo.updated', agentId: ctx.agent.id, items });
      const done = items.filter((t) => t.status === 'completed').length;
      return { text: `Todo list updated (${done}/${items.length} done):\n${items.map((t) => `- [${t.status}] ${t.content}`).join('\n')}`, output: items };
    },
  },
  {
    name: 'todo_read',
    readOnly: true,
    concurrencySafe: true,
    description: 'Read the current session TODO list.',
    inputSchema: obj({}),
    roles: READERS,
    run: async (_input, ctx) => {
      const items = ctx.app.repos.todos.get(ctx.session.id);
      return { text: items.length ? items.map((t) => `- [${t.status}] ${t.content}`).join('\n') : 'No todo list yet.', output: items };
    },
  },
  {
    name: 'scratchpad_write',
    readOnly: false,
    description:
      'Write (or overwrite) a named note in the session scratchpad. Use it to record findings, decisions, API names, ids and intermediate results so other agents and future runs can use them. Notes are visible to the user and survive interruptions.',
    inputSchema: obj(
      {
        title: { type: 'string', description: 'Short unique name, e.g. "Account field inventory"' },
        content: { type: 'string', description: 'Markdown' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      ['title', 'content'],
    ),
    roles: 'all',
    run: async (input, ctx) => {
      const note = ctx.app.repos.notes.upsert({
        sessionId: ctx.session.id,
        agentId: ctx.agent.id,
        role: ctx.agent.role,
        title: String(input.title).slice(0, 120),
        content: String(input.content).slice(0, 200_000),
        tags: input.tags ?? [],
      });
      ctx.runtime.bus.emit(ctx.session.id, {
        type: 'note.written',
        noteId: note.id,
        agentId: ctx.agent.id,
        role: ctx.agent.role,
        title: note.title,
        tags: note.tags,
      });
      return { text: `Note saved: "${note.title}"`, output: { id: note.id, title: note.title } };
    },
  },
  {
    name: 'scratchpad_read',
    readOnly: true,
    concurrencySafe: true,
    description: 'Read a scratchpad note by title, or all notes when title is omitted.',
    inputSchema: obj({ title: { type: 'string' } }),
    roles: 'all',
    run: async (input, ctx) => {
      const notes = input.title
        ? ([ctx.app.repos.notes.byTitle(ctx.session.id, input.title)].filter(Boolean) as any[])
        : ctx.app.repos.notes.list(ctx.session.id);
      if (!notes.length) {
        const text = input.title ? `No note titled "${input.title}"` : 'Scratchpad is empty.';
        return { text, output: { message: text } };
      }
      return {
        text: notes.map((n) => `## ${n.title} (by ${n.role})\n${clip(n.content, 20_000)}`).join('\n\n'),
        output: notes.map((n) => ({ id: n.id, title: n.title, role: n.role, tags: n.tags, updatedAt: n.updatedAt })),
      };
    },
  },
  {
    name: 'get_org_limits',
    readOnly: true,
    concurrencySafe: true,
    description: 'Get Salesforce org limits (API requests, storage, etc.) with usage percentages and warnings.',
    inputSchema: obj({}),
    roles: READERS,
    run: async (_input, ctx) => {
      const l = await ctx.runtime.refreshLimits(ctx.session.id);
      return {
        text:
          (l.warnings.length ? `WARNINGS: ${l.warnings.join('; ')}\n` : 'No limit warnings.\n') +
          l.limits
            .slice(0, 15)
            .map((x) => `${x.name}: ${x.usedPercent}% used (${x.remaining}/${x.max})`)
            .join('\n'),
        output: l,
      };
    },
  },
  {
    name: 'read_console_logs',
    readOnly: true,
    concurrencySafe: true,
    description:
      "Read what the browser's developer console recorded on the user's Salesforce tab: JavaScript errors, warnings and log output from Lightning components, LWC, Aura and Visualforce. Use it when the user reports a page that misbehaves, a component that will not render, or a button that does nothing — the console error is usually the whole answer, and it is invisible from the Salesforce APIs. Ask the user to reproduce the problem first, then read the logs. This is the browser console, not Apex debug logs: use get_apex_logs for server-side execution.",
    inputSchema: obj({
      levels: { type: 'array', items: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] }, description: 'Defaults to warn and error' },
      filter: { type: 'string', description: 'Only entries containing this text (case-insensitive)' },
      sinceSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: 3600,
        description: 'Only the last N seconds. Use it after asking the user to reproduce something.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
    roles: ['orchestrator', 'analyst', 'apex_builder', 'reviewer'],
    maxResultChars: 20_000,
    run: async (input, ctx) => {
      const limit = input.limit ?? 50;
      const r = await ctx.runtime.captureBrowser(ctx.session.id, ctx.agent.id, 'console', {
        since: sinceIso(input.sinceSeconds),
        filter: input.filter ?? null,
        limit,
      });
      if (r.unavailable) return { text: `Console capture unavailable: ${r.unavailable}`, ok: false };
      const levels = new Set<string>(input.levels?.length ? input.levels : ['warn', 'error']);
      const entries = (r.console ?? []).filter((e) => levels.has(e.level)).slice(-limit);
      if (!entries.length) {
        return {
          text: `No console entries matching ${[...levels].join('/')}${input.filter ? ` containing "${input.filter}"` : ''}${input.sinceSeconds ? ` in the last ${input.sinceSeconds}s` : ''}. A clean console is evidence too — the failure is probably server-side.`,
          output: { entries: [] },
        };
      }
      return {
        text:
          `${entries.length} console entr${entries.length === 1 ? 'y' : 'ies'}${r.dropped ? ` (${r.dropped} older ones dropped — the recording buffer wrapped)` : ''}:\n` +
          entries.map((e) => `[${e.level.toUpperCase()} ${e.at}] ${e.text}${e.source ? `\n    at ${e.source}` : ''}`).join('\n'),
        output: { entries, dropped: r.dropped },
      };
    },
  },
  {
    name: 'read_network_requests',
    readOnly: true,
    concurrencySafe: true,
    description:
      "Read the network calls the user's Salesforce tab made: Aura and LWC actions, REST and Apex REST calls, with method, URL, status and duration. Failed calls carry their response body. Use it when a page errors with nothing useful on screen, when a save silently fails, or to see which callout is slow. Defaults to failures only, which is what a diagnosis almost always needs.",
    inputSchema: obj({
      includeSuccessful: { type: 'boolean', description: 'Include 2xx calls too. Default false: failures are what diagnose a problem.' },
      filter: { type: 'string', description: 'Only calls whose URL contains this text (case-insensitive)' },
      sinceSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }),
    roles: ['orchestrator', 'analyst', 'apex_builder', 'reviewer'],
    maxResultChars: 20_000,
    run: async (input, ctx) => {
      const limit = input.limit ?? 30;
      const r = await ctx.runtime.captureBrowser(ctx.session.id, ctx.agent.id, 'network', {
        since: sinceIso(input.sinceSeconds),
        filter: input.filter ?? null,
        limit,
      });
      if (r.unavailable) return { text: `Network capture unavailable: ${r.unavailable}`, ok: false };
      const all = r.network ?? [];
      const entries = (input.includeSuccessful ? all : all.filter((e) => e.error || (e.status ?? 0) >= 400 || e.status === null)).slice(-limit);
      if (!entries.length) {
        return {
          text: input.includeSuccessful
            ? 'No network calls recorded in that window.'
            : `No failed network calls${input.filter ? ` matching "${input.filter}"` : ''}${input.sinceSeconds ? ` in the last ${input.sinceSeconds}s` : ''}. Every recorded call succeeded — pass includeSuccessful to see them.`,
          output: { entries: [] },
        };
      }
      return {
        text:
          `${entries.length} network call${entries.length === 1 ? '' : 's'}${r.dropped ? ` (${r.dropped} older ones dropped — the recording buffer wrapped)` : ''}:\n` +
          entries
            .map(
              (e) =>
                `[${e.at}] ${e.method} ${e.url} -> ${e.error ? `FAILED (${e.error})` : `${e.status}`}${e.durationMs != null ? ` in ${e.durationMs}ms` : ''}${e.responseBody ? `\n    body: ${e.responseBody}` : ''}`,
            )
            .join('\n'),
        output: { entries, dropped: r.dropped },
      };
    },
  },
  {
    name: 'request_deploy',
    readOnly: false,
    interruptBehavior: 'block',
    destructive: true,
    description:
      'Ask the user to confirm deploying the validated workspace to the org. Requires a clean validation of the current workspace. Blocks until the user answers. Provide a plain-language summary of the change.',
    inputSchema: obj({ summary: { type: 'string' }, impact: { type: 'string', description: IMPACT_DESCRIPTION } }, ['summary', 'impact']),
    roles: ['orchestrator'],
    run: async (input, ctx) => ctx.runtime.requestDeploy(ctx.session.id, input.summary, input.impact),
  },
  {
    name: 'commit_to_github',
    readOnly: false,
    interruptBehavior: 'block',
    description:
      "Ask the user to confirm committing the workspace and the session documentation to the client's GitHub repository (branch per the configured strategy). Blocks until the user answers.",
    inputSchema: obj(
      { message: { type: 'string', description: 'Commit message (imperative, <= 72 chars first line)' }, createPullRequest: { type: 'boolean' } },
      ['message'],
    ),
    roles: ['orchestrator'],
    run: async (input, ctx) => ctx.runtime.requestCommit(ctx.session.id, input.message, !!input.createPullRequest),
  },
  {
    name: 'write_documentation',
    readOnly: false,
    description: 'Write the session documentation (markdown, technical + end-user). Stored as persistent memory and committed with the next GitHub commit.',
    inputSchema: obj(
      {
        title: { type: 'string' },
        summary: { type: 'string', description: 'One paragraph for the memory index' },
        technical: { type: 'string', description: 'Markdown' },
        endUser: { type: 'string', description: 'Markdown, plain language' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      ['title', 'summary', 'technical', 'endUser'],
    ),
    roles: ['orchestrator', 'doc_writer'],
    run: async (input, ctx) => {
      const doc = await ctx.runtime.writeDoc(ctx.session.id, input);
      return { text: `Documentation written: ${doc.path}`, output: { id: doc.id, path: doc.path, title: doc.title } };
    },
  },
  {
    name: 'run_subagent',
    readOnly: false,
    requiresApprovedPlan: true,
    concurrencySafe: (input) => READ_ONLY_ROLES.has(input?.role),
    description: AGENT_PROMPT,
    inputSchema: obj(
      {
        role: { type: 'string', enum: [...DELEGATABLE_ROLES, 'analyst', 'metadata_builder', 'flow_builder', 'apex_builder', 'reviewer'] },
        objective: { type: 'string' },
        description: { type: 'string', description: 'Short description of the assignment' },
        runInBackground: { type: 'boolean' },
        forkContext: { type: 'boolean' },
        context: { type: 'string', description: 'Relevant facts gathered so far (ids, API names, user preferences)' },
      },
      ['role', 'objective'],
    ),
    roles: ['orchestrator'],
    run: async (input, ctx) => {
      const r = await ctx.runtime.startWorker(ctx, input.role, input.objective, input.context, !!input.runInBackground, !!input.forkContext);
      return { text: r.report, output: { agentId: r.agentId, role: input.role, ok: r.ok }, ok: r.ok };
    },
  },
  {
    name: 'update_task',
    readOnly: false,
    description: 'Update the status of the task linked to this session (if any).',
    inputSchema: obj({ status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'] }, note: { type: 'string' } }, ['status']),
    roles: ['orchestrator'],
    run: async (input, ctx) => {
      if (!ctx.session.taskId) return { text: 'No task is linked to this session.', ok: false };
      const t = ctx.app.repos.tasks.byId(ctx.session.taskId);
      if (!t) return { text: 'Linked task no longer exists.', ok: false };
      ctx.app.repos.tasks.update(t.id, {
        status: input.status,
        description: input.note ? `${t.description ?? ''}\n\n[${new Date().toISOString().slice(0, 10)}] ${input.note}`.trim() : undefined,
      });
      return { text: `Task "${t.title}" → ${input.status}` };
    },
  },
];

export function toolsForRole(role: AgentRole): ToolDef[] {
  const canonical = canonicalRole(role);
  const base: AgentRole =
    canonical === 'general' ? 'apex_builder' : canonical === 'verify' ? 'reviewer' : canonical === 'explore' || canonical === 'plan' ? 'analyst' : role;
  const coordination = new Set(['task_create', 'task_update', 'send_message']);
  const verification = new Set(['validate_deployment', 'run_apex_tests']);
  return TOOLS.filter((t) => {
    if (role !== 'orchestrator' && ['run_subagent', 'consult_specialist', 'investigate_product_repo'].includes(t.name)) return false;
    if (t.roles !== 'all' && !t.roles.includes(base) && !t.roles.includes(role)) return false;
    if (READ_ONLY_ROLES.has(role) && !t.readOnly && !coordination.has(t.name) && !(canonical === 'verify' && verification.has(t.name))) return false;
    return true;
  });
}
export function toLlmTools(defs: ToolDef[]): LlmTool[] {
  return defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
}
/** Count non-overlapping occurrences of a literal needle. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

/** Glob to RegExp: `**` crosses directory separators, `*` does not, `?` is one character. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

export function normalizePath(p: string): string {
  let s = String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');
  s = s.replace(/^force-app\/main\/default\//, '');
  return s;
}
export { ALL_ROLES };
