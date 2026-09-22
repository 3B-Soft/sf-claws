/** Static enumerations mirrored from @sf-claws/shared (kept as plain JS for template use). */
import {
  AgentRole,
  UserRole,
  UserStatus,
  OrgKind,
  SkillKind,
  SkillScope,
  TaskStatus,
  SessionStatus,
  AiProvider,
  ImpactCommand,
  PERMISSION_SUBJECTS,
} from '@sf-claws/shared';

export const AGENT_ROLES = AgentRole.options;
export const USER_ROLES = UserRole.options;
export const USER_STATUSES = UserStatus.options;
export const ORG_KINDS = OrgKind.options;
export const SKILL_KINDS = SkillKind.options;
export const SKILL_SCOPES = SkillScope.options;
export const TASK_STATUSES = TaskStatus.options;
export const SESSION_STATUSES = SessionStatus.options;
export const AI_PROVIDERS = AiProvider.options;
export const IMPACT_COMMANDS = ImpactCommand.options;
/** Presentation for each AI provider: card copy, key placeholder and badge. Keyed by AiProvider. */
export const PROVIDER_META = {
  anthropic: {
    label: 'Anthropic',
    desc: 'Claude Opus / Sonnet / Haiku with extended thinking.',
    color: 'orange',
    placeholder: 'sk-ant-…',
    badge: 'AN',
    badgeCls: 'bg-orange-500/15 text-orange-700',
  },
  openai: {
    label: 'OpenAI',
    desc: 'GPT-5 family. Prices in the model table are editable placeholders.',
    color: 'emerald',
    placeholder: 'sk-…',
    badge: 'OA',
    badgeCls: 'bg-emerald-500/15 text-emerald-700',
  },
  gemini: {
    label: 'Google Gemini',
    desc: "Gemini Pro and Flash through Google's OpenAI-compatible endpoint.",
    color: 'teal',
    placeholder: 'AIza…',
    badge: 'GE',
    badgeCls: 'bg-teal-500/15 text-teal-700',
  },
  deepinfra: {
    label: 'DeepInfra',
    desc: 'Open models hosted behind an OpenAI-compatible endpoint. Model ids are namespaced, e.g. deepseek-ai/DeepSeek-V3.',
    color: 'violet',
    placeholder: 'API key',
    badge: 'DI',
    badgeCls: 'bg-violet-500/15 text-violet-700',
  },
  deepseek: {
    label: 'DeepSeek',
    desc: 'DeepSeek Chat and Reasoner over the OpenAI-compatible API. Prices in the model table are editable placeholders.',
    color: 'sky',
    placeholder: 'sk-…',
    badge: 'DS',
    badgeCls: 'bg-sky-500/15 text-sky-700',
  },
};
/** What a scoped rule's pattern matches for each command, shown as a hint in the policy editor. */
export const IMPACT_SUBJECTS = PERMISSION_SUBJECTS;
export const IMPACT_META = {
  deploy: { label: 'Deploy', desc: 'Real metadata deploy after a clean validation' },
  execute_anonymous_apex: { label: 'Execute anonymous Apex', desc: 'Run Apex code in the org' },
  create_record: { label: 'Create record', desc: 'Insert data' },
  update_record: { label: 'Update record', desc: 'Modify data' },
  delete_record: { label: 'Delete record', desc: 'Remove data' },
  delete_component: { label: 'Delete component', desc: 'Destructive metadata change (executed at deploy)' },
  run_apex_tests: { label: 'Run Apex tests', desc: 'Runs tests in the org (heavy)' },
  soql_query_tooling: { label: 'Tooling API query', desc: 'Read, but heavier API use' },
  github_commit: { label: 'GitHub commit', desc: 'Push to the client repository' },
};
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const COMMIT_STRATEGIES = ['direct', 'branch-per-session', 'branch-per-task', 'pull-request'];

export const ROLE_META = {
  orchestrator: { label: 'Orchestrator', color: 'brand', desc: 'Plans, delegates, talks to the user' },
  analyst: { label: 'Analyst', color: 'sky', desc: 'Reads the org: SOQL, describe, debug logs, flows' },
  metadata_builder: { label: 'Metadata builder', color: 'violet', desc: 'Objects, fields, layouts, flexipages' },
  flow_builder: { label: 'Flow builder', color: 'fuchsia', desc: 'Flow XML specialist' },
  apex_builder: { label: 'Apex builder', color: 'orange', desc: 'Apex / LWC / triggers (pro mode)' },
  reviewer: { label: 'Reviewer', color: 'amber', desc: 'Quality gate, policy enforcement' },
  doc_writer: { label: 'Doc writer', color: 'emerald', desc: 'Technical + end-user documentation' },
  researcher: { label: 'Researcher', color: 'teal', desc: 'Searches linked product docs and source repositories' },
  summarizer: { label: 'Summarizer', color: 'slate', desc: 'Compaction, titles, memory extraction' },
};

/**
 * Presentation for a role, never undefined. A role added to the shared enum without an entry here
 * used to throw inside a getter and blank the whole page — that is how the role bindings editor and
 * the skill editor's role chips both went dark when `researcher` was added.
 */
export function roleMeta(role) {
  return ROLE_META[role] || { label: String(role || 'agent').replace(/_/g, ' '), color: 'slate', desc: '' };
}

/** Tailwind class sets per semantic color (static strings so Tailwind can see them). */
export const COLOR_CLASSES = {
  brand: 'border-brand-500/30 bg-brand-500/10 text-brand-600',
  sky: 'border-sky-500/30 bg-sky-500/10 text-sky-700',
  violet: 'border-violet-500/30 bg-violet-500/10 text-violet-700',
  fuchsia: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700',
  orange: 'border-orange-500/30 bg-orange-500/10 text-orange-700',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
  rose: 'border-rose-500/30 bg-rose-500/10 text-rose-700',
  slate: 'border-line-strong bg-surface-sunken text-content-muted',
  teal: 'border-teal-500/30 bg-teal-500/10 text-teal-700',
};

/** Map any status-ish string to a semantic color. */
export function statusColor(value) {
  switch (String(value || '').toLowerCase()) {
    case 'active':
    case 'connected':
    case 'completed':
    case 'succeeded':
    case 'done':
    case 'ok':
    case 'true':
    case 'enabled':
    case 'added':
    case 'created':
      return 'emerald';
    case 'pending':
    case 'awaiting_confirmation':
    case 'in_progress':
    case 'blocked':
    case 'expired':
    case 'sandbox':
    case 'modified':
    case 'renamed':
    case 'archived':
      return 'amber';
    case 'disabled':
    case 'disconnected':
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'false':
    case 'removed':
    case 'deleted':
    case 'production':
    case 'protected':
      return 'rose';
    case 'running':
    case 'connecting':
    case 'open':
    case 'info':
    case 'scratch':
    case 'developer':
      return 'sky';
    case 'superadmin':
    case 'orchestrator':
    case 'pro':
      return 'brand';
    case 'admin':
    case 'policy':
      return 'violet';
    case 'knowledge':
      return 'sky';
    case 'quality':
      return 'amber';
    case 'playbook':
      return 'teal';
    case 'global':
      return 'brand';
    case 'client':
      return 'violet';
    case 'org':
      return 'teal';
    case 'anthropic':
      return 'orange';
    case 'openai':
      return 'emerald';
    case 'gemini':
      return 'teal';
    case 'deepseek':
      return 'sky';
    case 'deepinfra':
      return 'violet';
    default:
      return ROLE_META[value]?.color || 'slate';
  }
}

/** Suggested model presets used when adding a model. OpenAI and DeepSeek prices are editable placeholders. */
export const MODEL_PRESETS = [
  {
    provider: 'anthropic',
    modelId: 'claude-opus-5',
    label: 'Claude Opus 5',
    inputCostPerM: 5,
    outputCostPerM: 25,
    cachedInputCostPerM: 0.5,
    maxOutputTokens: 32000,
    contextWindow: 200000,
    supportsThinking: true,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    inputCostPerM: 2,
    outputCostPerM: 10,
    cachedInputCostPerM: 0.2,
    maxOutputTokens: 32000,
    contextWindow: 200000,
    supportsThinking: true,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    inputCostPerM: 1,
    outputCostPerM: 5,
    cachedInputCostPerM: 0.1,
    maxOutputTokens: 16000,
    contextWindow: 200000,
    supportsThinking: true,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5',
    label: 'GPT-5',
    inputCostPerM: 1.25,
    outputCostPerM: 10,
    cachedInputCostPerM: 0.125,
    maxOutputTokens: 32000,
    contextWindow: 400000,
    supportsThinking: true,
    placeholderPrices: true,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5-mini',
    label: 'GPT-5 mini',
    inputCostPerM: 0.25,
    outputCostPerM: 2,
    cachedInputCostPerM: 0.025,
    maxOutputTokens: 32000,
    contextWindow: 400000,
    supportsThinking: true,
    placeholderPrices: true,
  },
  {
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    label: 'DeepSeek Chat',
    inputCostPerM: 0.28,
    outputCostPerM: 0.42,
    cachedInputCostPerM: 0.028,
    maxOutputTokens: 8000,
    contextWindow: 128000,
    supportsThinking: false,
    placeholderPrices: true,
  },
  {
    provider: 'gemini',
    modelId: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    inputCostPerM: 1.25,
    outputCostPerM: 10,
    cachedInputCostPerM: 0.31,
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    supportsThinking: true,
    placeholderPrices: true,
  },
  {
    provider: 'gemini',
    modelId: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    inputCostPerM: 0.3,
    outputCostPerM: 2.5,
    cachedInputCostPerM: 0.075,
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    supportsThinking: true,
    placeholderPrices: true,
  },
  {
    provider: 'deepinfra',
    modelId: 'deepseek-ai/DeepSeek-V3',
    label: 'DeepSeek V3 (DeepInfra)',
    inputCostPerM: 0.28,
    outputCostPerM: 0.42,
    cachedInputCostPerM: null,
    maxOutputTokens: 8000,
    contextWindow: 128000,
    supportsThinking: false,
    placeholderPrices: true,
  },
  {
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    inputCostPerM: 0.28,
    outputCostPerM: 0.42,
    cachedInputCostPerM: 0.028,
    maxOutputTokens: 64000,
    contextWindow: 128000,
    supportsThinking: true,
    placeholderPrices: true,
  },
];

export const DEFAULT_POLICY = {
  forbiddenMetadataTypes: [],
  protectedComponents: [],
  requireTestsForApex: true,
  minCodeCoverage: 75,
  alwaysConfirmDeploy: true,
  productionRequiresProMode: false,
  maxComponentsPerDeploy: 200,
  allowDataModification: false,
  impactAllowList: [...ImpactCommand.options],
  impactDenyList: [],
  sessionAllowable: ['soql_query_tooling', 'run_apex_tests'],
  apiLimitWarnPercent: 80,
};

/** Icons (inline SVG path data, 24x24 stroke) used across the UI. */
export const ICONS = {
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  ai: 'M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4zM9 13h.01M15 13h.01M9 17h6',
  clients: 'M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01',
  skills: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z',
  docs: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  sessions: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  usage: 'M18 20V10M12 20V4M6 20v-6',
  audit: 'M9 12h6M9 16h6M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  pair: 'M17 2h-2a2 2 0 0 0-2 2v2h6V4a2 2 0 0 0-2-2zM7 22h2a2 2 0 0 0 2-2v-2H5v2a2 2 0 0 0 2 2zM12 6v12M8 10l-4 4 4 4M16 14l4-4-4-4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  warning: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  error: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  chevronRight: 'm9 18 6-6-6-6',
  chevronDown: 'm6 9 6 6 6-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  tool: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  rocket:
    'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  thumbUp: 'M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3',
  thumbDown: 'M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17',
  brain:
    'M12 4.5a3 3 0 0 0-5.6 1.4A3.5 3.5 0 0 0 4 9.2a3.5 3.5 0 0 0 .9 5.3A3.5 3.5 0 0 0 8 19.5h4V4.5zM12 4.5a3 3 0 0 1 5.6 1.4 3.5 3.5 0 0 1 2.4 3.3 3.5 3.5 0 0 1-.9 5.3 3.5 3.5 0 0 1-3.1 5H12',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  message:
    'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
  play: 'M5 3l14 9-14 9V3z',
  stop: 'M6 6h12v12H6z',
  spinner: 'M21 12a9 9 0 1 1-6.22-8.56',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  kanban: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v7h-4z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  note: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  gauge: 'M12 14l4-6M3 17a9 9 0 1 1 18 0M12 17h.01',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.93 4.93l14.14 14.14',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
};

export const TOOL_ICONS = {
  soql_query: 'database',
  describe_sobject: 'database',
  describe_global: 'database',
  list_metadata: 'folder',
  read_metadata: 'file',
  write_workspace_file: 'edit',
  delete_workspace_file: 'trash',
  validate_deploy: 'shield',
  deploy: 'rocket',
  github_commit: 'git',
  write_doc: 'skills',
  read_skill: 'skills',
  spawn_agent: 'ai',
  debug_log: 'audit',
  tooling_query: 'database',
};
export function toolIcon(tool) {
  if (!tool) return 'tool';
  if (TOOL_ICONS[tool]) return TOOL_ICONS[tool];
  const t = String(tool).toLowerCase();
  if (t.includes('query') || t.includes('describe')) return 'database';
  if (t.includes('deploy') || t.includes('validate')) return 'rocket';
  if (t.includes('git') || t.includes('commit')) return 'git';
  if (t.includes('doc')) return 'skills';
  if (t.includes('file') || t.includes('write') || t.includes('metadata')) return 'file';
  return 'tool';
}
