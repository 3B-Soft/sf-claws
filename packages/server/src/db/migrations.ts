export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: 'init',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin','admin','user')),
  status TEXT NOT NULL CHECK (status IN ('pending','active','disabled')),
  ui_mode TEXT NOT NULL DEFAULT 'visual',
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  last_seen_at TEXT
);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,           -- jti
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- web | extension
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);
CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id);

CREATE TABLE device_codes (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_user_id TEXT,
  token TEXT,
  consumed_at TEXT
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE github_repos (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  source_root TEXT NOT NULL DEFAULT 'force-app/main/default',
  docs_root TEXT NOT NULL DEFAULT 'docs/harness',
  commit_strategy TEXT NOT NULL DEFAULT 'branch-per-session',
  branch_prefix TEXT NOT NULL DEFAULT 'harness/',
  token_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  sf_org_id TEXT,
  instance_url TEXT,
  my_domain_host TEXT,
  login_url TEXT NOT NULL,
  api_version TEXT NOT NULL DEFAULT '62.0',
  username TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  protected INTEGER NOT NULL DEFAULT 0,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  created_at TEXT NOT NULL,
  last_connected_at TEXT,
  last_error TEXT
);
CREATE INDEX idx_orgs_client ON orgs(client_id);
CREATE INDEX idx_orgs_sf_org ON orgs(sf_org_id);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE provider_credentials (
  provider TEXT PRIMARY KEY,
  api_key_enc TEXT NOT NULL,
  base_url TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE ai_models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  input_cost_per_m REAL NOT NULL DEFAULT 0,
  output_cost_per_m REAL NOT NULL DEFAULT 0,
  cached_input_cost_per_m REAL,
  max_output_tokens INTEGER NOT NULL DEFAULT 16000,
  context_window INTEGER NOT NULL DEFAULT 200000,
  supports_thinking INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(provider, model_id)
);

CREATE TABLE role_bindings (
  role TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  effort TEXT NOT NULL DEFAULT 'high',
  max_iterations INTEGER NOT NULL DEFAULT 40
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  roles TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  seed_file TEXT
);

CREATE TABLE policies (
  scope_key TEXT PRIMARY KEY,   -- 'global' or 'client:<id>'
  rules TEXT NOT NULL,          -- json PolicyRules (partial for client overrides)
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  ui_mode TEXT NOT NULL DEFAULT 'visual',
  page_context TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  helpful INTEGER,
  feedback_note TEXT,
  branch_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, created_at);
CREATE INDEX idx_sessions_org ON sessions(org_id, created_at);
CREATE INDEX idx_sessions_client ON sessions(client_id, created_at);

CREATE TABLE session_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,         -- provider role: user | assistant | tool
  content TEXT NOT NULL,      -- json normalized message
  created_at TEXT NOT NULL
);
CREATE INDEX idx_session_messages ON session_messages(session_id, agent_id, created_at);

CREATE TABLE workspace_files (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  original TEXT,
  metadata_type TEXT,
  full_name TEXT,
  action TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE TABLE deploy_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  check_only INTEGER NOT NULL,
  status TEXT NOT NULL,
  sf_deploy_id TEXT,
  attempt INTEGER NOT NULL,
  components_total INTEGER NOT NULL DEFAULT 0,
  components_failed INTEGER NOT NULL DEFAULT 0,
  tests_total INTEGER NOT NULL DEFAULT 0,
  tests_failed INTEGER NOT NULL DEFAULT 0,
  code_coverage REAL,
  failures TEXT NOT NULL DEFAULT '[]',
  test_level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_deploy_runs_session ON deploy_runs(session_id, created_at);

CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  resolved_option TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_session ON usage_records(session_id);
CREATE INDEX idx_usage_created ON usage_records(created_at);

CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  committed_sha TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_docs_org ON docs(org_id, created_at);
CREATE VIRTUAL TABLE docs_fts USING fts5(title, summary, markdown, content='docs', content_rowid='rowid');
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, summary, markdown) VALUES (new.rowid, new.title, new.summary, new.markdown);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, summary, markdown) VALUES ('delete', old.rowid, old.title, old.summary, old.markdown);
END;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  ip TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
`,
  },
  {
    name: 'todos_notes_permissions_limits',
    sql: `
CREATE TABLE session_todos (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  items TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_agent TEXT
);
CREATE TABLE session_notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_session_notes ON session_notes(session_id, updated_at);
CREATE TABLE session_permissions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (session_id, command)
);
CREATE TABLE org_limits (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`,
  },
  {
    name: 'plan_mode_telemetry_artifacts',
    sql: `
-- Plan mode: the approved plan lives on the session so resume, the reviewer and the doc writer
-- all read what was actually agreed with the user.
ALTER TABLE sessions ADD COLUMN plan_markdown TEXT;
ALTER TABLE sessions ADD COLUMN plan_approved_at TEXT;
ALTER TABLE sessions ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 0;

-- Per-tool observability for super admins: which tools are used, which fail, what they cost in
-- time and context. Separate from usage_records, which is per model call.
CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  result_chars INTEGER NOT NULL DEFAULT 0,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tool_invocations_session ON tool_invocations(session_id, created_at);
CREATE INDEX idx_tool_invocations_tool ON tool_invocations(tool, created_at);

-- Oversized tool results are persisted here and replaced in context by a short preview plus a
-- handle, so the agent can page back into the full output instead of losing its tail.
CREATE TABLE tool_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tool_artifacts_session ON tool_artifacts(session_id, created_at);

CREATE INDEX idx_usage_client_created ON usage_records(client_id, created_at);

-- Provider keys become per-user-or-global. SQLite cannot alter a primary key, so rebuild the table
-- and carry existing rows over as global (user_id NULL) credentials.
CREATE TABLE provider_credentials_v2 (
  provider TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  api_key_enc TEXT NOT NULL,
  base_url TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
INSERT INTO provider_credentials_v2 (provider, user_id, api_key_enc, base_url, updated_at, updated_by)
  SELECT provider, NULL, api_key_enc, base_url, updated_at, updated_by FROM provider_credentials;
DROP TABLE provider_credentials;
ALTER TABLE provider_credentials_v2 RENAME TO provider_credentials;
-- A partial unique index gives ON CONFLICT a target that treats NULL user_id as one global row
-- (a plain UNIQUE would let duplicate globals through, since NULLs never compare equal).
CREATE UNIQUE INDEX idx_provider_credentials_user ON provider_credentials(provider, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_provider_credentials_global ON provider_credentials(provider) WHERE user_id IS NULL;

-- Knowledge sources: documentation repositories and source repositories the agents may search to
-- ground themselves in how the products deployed in a client's org actually work.
CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_ref TEXT NOT NULL,
  guidance TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'global',
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  token_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_knowledge_sources_scope ON knowledge_sources(scope, client_id);

-- Envelope encryption: one data key per tenant, itself wrapped by the server master key. A leaked
-- ciphertext or a compromised tenant key exposes one tenant, not all of them.
CREATE TABLE tenant_keys (
  key_id TEXT PRIMARY KEY,
  wrapped_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

-- Specialists a super admin defines without a deploy. base_role fixes the tool set, so a
-- specialist can never be given reach the built-in role does not already have.
CREATE TABLE custom_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  when_to_use TEXT NOT NULL DEFAULT '',
  base_role TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'global',
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_custom_agents_scope ON custom_agents(scope, client_id);
`,
  },
  {
    name: 'agent_instructions',
    sql: `
-- Always-loaded agent instructions, the equivalent of a CLAUDE.md checked into a repository.
-- Deliberately not a skill: skills are role-filtered and expanded from a menu, whereas this is read
-- by every agent on every session, which is what makes it the right home for a client's standing
-- conventions and the facts about their org that never change.
ALTER TABLE clients ADD COLUMN instructions TEXT;
ALTER TABLE orgs ADD COLUMN instructions TEXT;
`,
  },
  {
    name: 'model_sampling_dials',
    sql: `
-- Super-admin sampling dials. NULL means "send nothing", which is both the provider default and the
-- only valid setting for a thinking model, so NULL rather than a numeric default is deliberate.
ALTER TABLE ai_models ADD COLUMN temperature REAL;
ALTER TABLE ai_models ADD COLUMN top_p REAL;
`,
  },
  {
    name: 'client_members',
    sql: `
-- Which consultants may see which clients. A 'user' sees only the clients they are a member of;
-- admins and super admins administer the platform and see every client, so they are never listed
-- here. Membership is the whole rule: there is deliberately no per-client role or permission set.
CREATE TABLE client_members (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (client_id, user_id)
);
CREATE INDEX idx_client_members_user ON client_members(user_id);
`,
  },
  {
    name: 'client_members_role',
    sql: `
-- Membership grew a level: 'member' sees the client and their own sessions, 'admin' (a client admin)
-- sees every session of that client. Platform admins now need a membership too; only the super admin
-- belongs to every client implicitly (see docs/TENANCY.md). Existing rows become plain members.
ALTER TABLE client_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin'));
CREATE INDEX idx_client_members_client ON client_members(client_id);
`,
  },
  {
    name: 'org_connected_app',
    sql: `
-- Each org authorizes through its own Connected App, entered when the org is added. The consumer key
-- identifies the app and is not secret; the consumer secret is tenant-encrypted like the tokens. NULL
-- keeps the server-wide SF_CLIENT_ID, which orgs connected before this hold refresh tokens for.
ALTER TABLE orgs ADD COLUMN consumer_key TEXT;
ALTER TABLE orgs ADD COLUMN consumer_secret_enc TEXT;
`,
  },
  {
    name: 'compile_control',
    sql: `
CREATE TABLE session_compile_control (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL
);
ALTER TABLE deploy_runs ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';
`,
  },
  {
    name: 'harness_recovery_hydration',
    sql: `
ALTER TABLE orgs ADD COLUMN schema_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE validation_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  deploy_id TEXT NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  comparison_key TEXT NOT NULL,
  root_count INTEGER,
  restored_from TEXT,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_checkpoints_session ON validation_checkpoints(session_id, created_at);
CREATE UNIQUE INDEX idx_checkpoints_org_active ON validation_checkpoints(org_id) WHERE status IN ('in_progress','uncertain');
CREATE TABLE validation_attempts (
  checkpoint_id TEXT NOT NULL REFERENCES validation_checkpoints(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (checkpoint_id, attempt)
);
CREATE TABLE session_hydration (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  bundle TEXT NOT NULL
);
`,
  },
  {
    name: 'client_salesforce_auth_mode',
    sql: `
-- Browser-session mode is an explicit client-wide alternative to durable OAuth. Session IDs are
-- held in process memory only; this column stores the choice, never the credential.
ALTER TABLE clients ADD COLUMN salesforce_auth_mode TEXT NOT NULL DEFAULT 'external_app'
  CHECK (salesforce_auth_mode IN ('external_app','browser_session'));
`,
  },
  {
    name: 'session_agent_state',
    sql: `CREATE TABLE session_agent_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      state TEXT NOT NULL
    );`,
  },
  {
    name: 'session_memory_exclusion',
    sql: `ALTER TABLE sessions ADD COLUMN excluded_from_memory INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_memory IN (0, 1));`,
  },
];
