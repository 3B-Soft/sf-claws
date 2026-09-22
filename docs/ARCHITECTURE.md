# Architecture

Read this before changing the agent runtime. `docs/TENANCY.md` covers the isolation model,
`CONTRIBUTING.md` covers the conventions and why they exist.

## Where things run

Everything agentic runs on the server. The Chrome extension renders and reports which Salesforce
page the user is on; it never talks to Salesforce, GitHub or a model provider itself. A turn keeps
running when the panel closes, and the panel reconnects to the event stream and replays.

## Components

### Control plane (`packages/server`)

One Bun process (Fastify 5, TypeScript, ESM). State in SQLite (WAL) via bun:sqlite — a
single file under `DATA_DIR`, migrations in `src/db/migrations.ts`, append-only. Secrets are
AES-256-GCM encrypted: client-owned secrets under that client's own data key, wrapped by
`MASTER_KEY` (`lib/crypto.ts`). Passwords use scrypt. JWTs (HS256, `jose`) carry a `jti` stored in
`auth_tokens` so they can be revoked.

Modules:

- `auth/` — registration (first user is super admin, the rest are pending), login, device pairing
  for the extension.
- `salesforce/` — OAuth 2.0 web-server flow with PKCE; jsforce connections with automatic refresh;
  REST/Tooling queries; describe; Metadata API list/retrieve/deploy with polling. `sdr.ts` converts
  between SFDX source format (what agents write and what is committed) and Metadata API format using
  Salesforce's own `source-deploy-retrieve` over an in-memory virtual tree — agents never touch the
  host filesystem, and the deploy zip is built in memory and streamed to Salesforce. Deletions are
  layered in as `destructiveChangesPost.xml` rather than through SDR's destructive-changes API,
  which folds them into `package.xml` and would ask Salesforce to create them. `metadata-xml.ts`
  holds what does not need delegating: manifests, well-formedness checks, the render projection.
- `github/` — Octokit against the Git Data API: blobs → tree → commit → ref, so no clone is needed.
- `ai/` — provider-neutral message model; `anthropic.ts`, and `openai.ts`, which holds two
  transports. OpenAI itself uses the Responses API (`/v1/responses`), because newer models refuse
  function tools beside a reasoning effort on Chat Completions: it sends `reasoning: { effort }` with
  `store: false`, streams reasoning summaries as thinking, announces each function call on its
  `output_item.done`, and keeps the encrypted reasoning items in the message's `raw` so the same
  model gets them back on the next turn. Every OpenAI-compatible gateway stays on Chat Completions
  through a dialect (`deepseek.ts` and `deepinfra.ts` are two: `max_tokens`, no effort knob,
  thinking streamed back as `reasoning_content`). `types.ts` owns `SYSTEM_CACHE_BOUNDARY` and
  `splitSystemPrompt`, which is what makes the prompt ordering a real cost boundary: Anthropic gets
  two system blocks with the breakpoint after the stable half, and the OpenAI-family endpoints get
  the marker stripped. Sampling dials are per model and are never sent to a thinking model, which
  rejects them. `registry.ts` resolves role → model bindings, per-user provider keys, fallback
  models and cost.
- `agents/` — the runtime. See below.
- `knowledge/` — documentation corpora and repository snapshots the agents research.
- `skills/` — markdown skills with front matter, seeded on first boot, injected per role.

### Agent runtime (`packages/server/src/agents`)

- `runtime.ts` — `SessionRuntime`: one turn at a time per session. Runs the orchestrator (persistent
  conversation) which delegates to ephemeral sub-agents. Owns validation, deploy, commit, docs,
  confirmations, the allow-list gate, plan mode, spend ceilings, org limits, snapshot and resume.
- `agent.ts` — `AgentRun`: the agentic loop over the provider abstraction. Scheduling, retries,
  compaction, budgets, stop reasons.
- `scheduler.ts` — partitions a turn's tool calls into contiguous concurrency-safe and unsafe
  batches, preserving emission order. Safe batches run in parallel (bounded); unsafe ones run one at
  a time. Results are reassembled in the original order.
- `tools.ts` — the tool set and the `ToolDef` contract (`readOnly`, `concurrencySafe`, `destructive`,
  `maxResultChars`, `requiresApprovedPlan`, `earlyStart`, `interruptBehavior`). Tools are filtered
  per role. Tools return their full text: clipping and spilling is the budget layer's job, so the
  tail of a long result is paged back into rather than lost.
- `apex-classify.ts` — decides whether an anonymous Apex script is read-only, failing closed: only
  queries, locals, collections and `System.debug`/assertions qualify; a call into any class the
  classifier does not know, a constructor of a non-collection type, or any DML counts as mutating.
- `cache-probe.ts` — hashes each prompt section and the tool array per call and logs which section
  changed whenever the provider's cached-token count drops for the same agent.
- `budget.ts` — per-tool and per-turn result limits; oversized output spills to a `tool_artifacts`
  row and is replaced by a preview plus a handle the agent can page back into.
- `cost.ts` — spend ceilings, checked before each model call with the call's projected price.
- `conversation.ts` — repairs dangling `tool_use` blocks left by a crash or an abort, and swaps in
  the user's later answer for an interrupted `ask_user` / `submit_plan` call.
- `coerce.ts` — normalises stringified numbers and booleans in tool arguments, then validates the
  `required` list, enums and basic types so a missing argument is an error the model can act on
  rather than a `"undefined"` sent to Salesforce.
- `backoff.ts` — jittered exponential backoff with `Retry-After` support.
- `reminders.ts` — `<system-reminder>` blocks appended to tool results when state warrants it. The
  static prompt introduces the tag and the rule that a reminder is never mentioned to the user.
  Reminders are gated on "since it last fired" rather than on state alone: the org-limit warning
  once per threshold crossing, the todo nudge once per drift window, the plan-pending and
  reviewer-read-only lines in full once and then sparsely, the budget position once at 50, 75 and
  90 percent of a ceiling.
- `prompts.ts` — role identities and guidance, assembled with the cacheable half first.
- `policy.ts` — programmatic enforcement of `PolicyRules`.
- `events.ts` — per-session event bus; events are persisted with a sequence number and streamed over
  SSE with resume (`?after=`).

### Contract (`packages/shared`)

`domain.ts` entities, `api.ts` routes and request/response schemas, `events.ts` the session event
union, `metadata.ts` the source-format registry and path helpers. Both UIs and the server import it,
so changing it first is not a style preference — it is what keeps them from drifting.

### UIs

Both UIs share one palette: semantic tokens (`surface`, `content`, `line`, `brand`) defined per
package in `styles.css` from the Salesforce Lightning colours, so the side panel does not read as a
foreign object docked beside the org. `tools/contrast-audit.mjs` (`bun run contrast`) checks every
text node on every screen against its real composited background and fails anything below WCAG AA.

LWC Open Source with light-DOM components and Tailwind v4, built with Vite through
`tools/vite-lwc-plugin.mjs`. The extension is Manifest V3 with a side panel, a background service
worker (tab tracking) and a content script (page context: record, object, setup page, flow builder).

## The agent loop

Per iteration, in order:

1. **Budget check, with projection.** Before the model call, never after — after only reports
   money already gone. The check adds what the call is about to cost (estimated input tokens at
   the input rate plus the reserved output slot at the output rate) to the spend so far, so a
   large call cannot pass at $0 spent and overshoot a small ceiling by its whole price. The
   compaction summariser is projected and refused the same way, and honours the abort signal.
2. **Compaction if needed.** First evict superseded tool-result bodies by id (cheap, keeps every
   assistant decision intact); only if that is not enough, pay for summarisation. The cut is the
   latest assistant message at least six messages from the end, so the tail — the tool pairs the
   model is working on, including the validation failure it is fixing — stays verbatim and every
   `tool_use` keeps its `tool_result`. The summariser gets a structured brief (nine sections,
   an `<analysis>` draft that is stripped, a client's `## Compact instructions` block when its
   standing instructions carry one), the summarised transcript is kept as an artifact reachable
   through `read_tool_output`, and the injected summary ends with a resume line so the model
   continues instead of acknowledging it.
3. **Model call.** Bounded retries with jittered backoff; `Retry-After` honoured; a context-window
   rejection triggers exactly one hard compaction and retry; a fallback model is tried once after
   the primary's retries are exhausted, with thinking signatures stripped (they are model-bound).
   The model that actually answered is what gets recorded — for billing and as the owner of the
   raw content that is replayed verbatim — so a fallback's signatures are never sent to the
   primary. A retry also clears the read memo: an early-started read may have been memoised for a
   message that was thrown away.
4. **Stop-reason check.** Refusal; truncation, which widens the output slot and sends a
   continuation instruction ("resume, no recap, smaller pieces") rather than replaying the
   truncated turn; or no tool calls (done).
5. **Stuck-loop check.** Three identical consecutive call sets means stop and report, not retry.
   So does a validation failing with the same failure set three times in a row — a builder making
   cosmetic edits between validations never repeats a call, but it does repeat the failures.
6. **Tool execution.** Scheduled by concurrency safety; plan gate, argument coercion and
   required-argument validation applied per call; results budgeted per tool and per turn;
   reminders appended.

A sub-agent that reaches its iteration cap, or a researcher that has spent its read budget, is
not returned as it stands: the loop makes one more tool-less call asking for the report from what
it has, so the lead agent receives a hand-over rather than the tail of a search.

Cancelling is not always immediate. A tool declares `interruptBehavior: 'block'` (deploys, commits,
validations, anonymous Apex, test runs, record writes) when a user cancel must let it finish and
record its result; the runtime waits for those before marking the session cancelled. Everything
else is `'cancel'`: the result is discarded and the loop stops at the next check.

A tool call does not wait for the whole message. Providers announce a `tool_use` block through
`onToolCall` as soon as it finishes streaming, and the loop starts it immediately when three things
hold: the call is a **concurrency-safe read**, the tool has not opted out with `earlyStart: false`
(`investigate_product_repo` and `consult_specialist` start a paid sub-agent, which is not a read
whatever the org thinks), and every preceding call in the message was eligible too.
Concurrency-safe alone is not enough — `run_subagent` qualifies for an analyst, and starting one
speculatively would spend real money on a message a mid-stream failure may throw away. The prefix
condition means early starts are always the leading run of safe reads, which is exactly the first
batch the scheduler would have run in parallel: ordering, budgeting and what the model sees are
unchanged, only the start time moves. `execBatch` collects the running promise by `tool_use` id
rather than re-running the call.

Output slot reservation is 8k by default, escalated to 64k once on truncation: the API deducts
`max_tokens` from usable context whether the model uses it or not.

## Prompt assembly and caching

Providers cache on an exact prefix match, so the system prompt is ordered stable-first:

```
identity → context and harness mechanics → rules → care → policy → plan rules → skills
  → role guidance and report contract → sub-agent rules → knowledge (with the docs index)
  → specialists → client and org instructions
──────────────────────── cacheable boundary ────────────────────────
session state (plan, page context, spend ceilings) → memory index → specialist instructions
```

The boundary is not a comment: `ai/types.ts` defines it and the Anthropic provider splits the
prompt there into two text blocks, with the cache breakpoint on the first only. The other
breakpoints are the last tool definition and a rolling point behind the conversation head. Moving
a volatile section above the boundary re-bills the whole prefix every turn, which is why
`buildPromptSections` names every section and `cache-probe.ts` logs which one changed whenever
the cached-token count drops for an agent.

A sub-agent's objective is not in the system prompt at all. It goes in the first user message, so
four analysts started in one turn share one cached prefix; the same is true of a specialist's
admin-written instructions, which sit in the dynamic half. Spend ceilings are in the dynamic half
because raising one is the documented recovery path. The harness-mechanics section is built from
the role's actual tool set, so no role is told about a tool it lacks, and each role carries its own
report contract (builders: COMPONENTS TOUCHED / VALIDATION STATUS / OPEN QUESTIONS; analysts:
FINDINGS / EVIDENCE / RECOMMENDATION; the researcher its five sections; the reviewer BLOCKERS /
WARNINGS / SUGGESTIONS and a `VERDICT:` line).

Skills load in two phases: policy and quality inline (short and authoritative), knowledge and
playbooks as a one-line menu the agent expands with `load_skill`.

## Data flow of a change

1. User message → `POST /sessions/:id/messages` → `startTurn` → orchestrator loop.
2. For non-trivial work the orchestrator investigates, then `submit_plan` → the user approves →
   staging tools unlock. "Non-trivial" means delegating to a builder, touching Apex or Flow, or
   changing more than one component.
3. Builders `write_workspace_file` / `edit_workspace_file` (policy-checked, XML validated, the org's
   current version fetched once for the diff) and `validate_deployment` → `checkOnly` deploy →
   iterate until clean.
4. `request_deploy` → allow-list check → confirmation → real deploy → `deploy.result`.
5. `commit_to_github` → confirmation → Git Data API commit of source plus documentation.
6. `write_documentation` → a `docs` row, indexed for memory and committed with the next commit. If
   the turn did meaningful work and no docs were written, the runtime runs the doc writer itself.

## Approvals and policy

`PolicyRules.impactAllowList` and `impactDenyList` decide which commands the agents may even
attempt. Entries are **permission rules**: a bare command name, or one scoped to a subject pattern
(`update_record(Account)`, `delete_component(*__c)`, `github_commit(*#main)`). Each command defines
its own subjects — the sObject, the components in the deploy, the branch — listed in
`PERMISSION_SUBJECTS` so an admin knows what a pattern matches.

`shared/permissions.ts` holds the evaluation, and `PolicyService.checkCommand` is the single entry
point every caller goes through, so a rule cannot take effect on one path and not another. The
order:

1. **Deny wins**, matching one subject is enough. Half a batch is not a safe outcome.
2. **Every subject must be allowed.** A deploy of five components needs all five covered — otherwise
   one permitted component carries four unreviewed ones in beside it.
3. **Otherwise refuse.** A scoped rule with no determinable subject refuses too: scoping says only
   certain subjects are acceptable, and "we could not tell" is not one of them.

A command that passes goes through `runtime.gate()`: the tool must pass a plain-language `reason`
(checked before any grant, so a granted command still has to explain itself), and the user sees the
reason and the exact command, then chooses *Allow once*, *Allow for this session* (only where
`sessionAllowable` covers it; never deploys or commits) or *Deny*. Session grants live in
`session_permissions` as permission rules scoped to the subjects that were approved
(`run_apex_tests(FooTest)`), are revocable, and skip only the *prompt* — the rules are re-evaluated
on every call and every subject of a new call must be covered by a grant, so "allow for this
session" on one test class never covers another.

`executeDeploy` and `executeCommit` are the real actions behind both the agent's request and the
panel's buttons, and both run `checkCommand` themselves, so a deny rule stops the human as well as
the agent. They also require proof of a confirmation: the id of the answered confirmation card, or
a `confirmedBy` argument from a route whose own UI asked the user. `alwaysConfirmDeploy` is
enforced there, not merely rendered into the prompt.

The reviewer is a gate, not advice. `runSubagent` parses the reviewer's `VERDICT: PASS | FAIL |
PARTIAL` line and stores it, with a hash of the workspace it reviewed, as a scratchpad note.
`request_deploy` refuses when the latest verdict for the current workspace is FAIL, and — under the
default `reviewerVerdictPolicy` of `nontrivial` (code, automation or more than one component) —
when no verdict exists for the workspace as staged now. A FAIL blocks the panel's Deploy button
too. The plan gate lets read-only delegation (analyst, reviewer, researcher, and specialists built
on them) through while a plan is pending, in every mode: planning well depends on investigating.

Spend ceilings (`maxTurnCostUsd`, `maxSessionCostUsd`, `maxClientMonthlyCostUsd`) are hard limits.
`costCeilingDocReserveUsd` is carved out of the ceiling rather than added to it: ordinary agents stop
early so the documentation guarantee can still run, and the configured number stays a true maximum.

## Knowledge sources

Two kinds, both configured per deployment with nothing product-specific compiled in:

- **docs** — a repository of markdown loaded as a searchable corpus with a compact index. Any
  layout works, including the product content-repo shape (`products.json`,
  `<product>/articles|faq/*.md`, `<product>/releases/<version>/index.md`). Dot and underscore
  folders (`.docs`, `_temp`) and root `CLAUDE.md`/`AGENTS.md` are authoring material and skipped.
  When no docs source can load (missing token, bad ref), search and read fail with the reason
  instead of answering "no matches".
- **repo** — a source repository searched on demand by the `researcher` sub-agent.

`knowledge/repo-store.ts` downloads a branch tarball once and serves grep, read, glob and path
search from memory: one download instead of hundreds of Contents API calls. Bounded throughout —
per-file and total size caps, an LRU of two snapshots, a grep deadline, binaries and dependency
directories skipped. Model-supplied regexes go through `knowledge/pattern-guard.ts`, which rejects
the shapes that backtrack exponentially; see the comment there for why truncation alone is not
enough. A multiline grep matches against whole files and reports the line each match starts on;
every grep returns `totalMatches` and a continuation `offset` so a page is never mistaken for the
whole result. The documentation index (paths and titles, sorted and capped) is part of the
knowledge section of the prompt, in the cached prefix, so an agent can orient without a search.

Each source carries its own read-only credential and never borrows a client's GitHub token.

## Standing instructions

A client, and each of its orgs, carries an `instructions` markdown document — the equivalent of a
CLAUDE.md checked into a repository. Every agent on every session reads it. It is deliberately not
a skill: skills are role-filtered and expanded from a menu, this is always in the prompt, which is
what makes it the right home for a client's conventions and the facts about their org that never
change. The org's text comes after the client's, so the more specific one wins, and both sit in the
cacheable half of the prompt since neither changes during a session. Neither can widen what an agent
may do: the non-negotiable rules and the policy still decide that, and the prompt says so.

## Page context

The extension reports what the user is looking at — url, title, record, object, flow, setup page —
when a session is created **and with every message**. Over a long session people move around the
org, and an agent still reasoning about the record they opened an hour ago is worse than one with no
page context at all. The runtime stores it on the session and emits `session.page`, so the next
turn's prompt and any sub-agent started in it see the current page. Only Salesforce tabs are
reported; a panel left open on an unrelated tab sends nothing.

## Reading the browser

`read_console_logs` and `read_network_requests` show what the user's browser actually did — the
JavaScript error behind a component that will not render, the failed Aura action behind a save that
silently does nothing. Nothing in the Salesforce APIs can tell an agent that.

The server cannot reach the page, so this is a request/response over the channels that already
exist: a `browser.request` event out on the session stream, an answer back to
`POST /sessions/:id/browser-capture`, correlated by `requestId` and scoped to the session that
asked. The waiter is registered before the event is emitted — a panel answering synchronously would
otherwise beat its own waiter into existence.

Capture itself is a `world: "MAIN"` content script (`extension/src/recorder.js`), the only place
console output and `fetch`/`XMLHttpRequest` can be observed. It keeps fixed-size ring buffers,
reports how many entries it dropped so a truncated window is never mistaken for a quiet one, reads
response bodies **only for failed calls** (a successful Aura action's body is the user's data, not a
diagnostic), and never blocks the page. Filtering by level, text and time happens in the panel, so
only the entries the agent asked for leave the browser.

Every failure path resolves rather than hangs: a closed panel, a non-Salesforce tab or a page loaded
before the recorder was injected all come back as "unavailable" with a reason. A diagnostic the
agent could not fetch is a fact to report, not an error, and never a stalled turn.

## Memory

Session documentation is the org's long-term memory. An always-loaded capped index sits in the
prompt with a human-readable age per entry ("47 days ago"), and `search_memory` (FTS5) pulls the
full text on demand. Ages are prose rather than timestamps because that is what makes a model
re-check a stale claim instead of asserting it.

## Recovery

Everything in a session is persisted: events, orchestrator messages, todo list, notes, workspace,
deploy runs, confirmations, docs. `GET /sessions/:id/snapshot` returns it all for local caching.
On boot, sessions left running, awaiting a confirmation or awaiting a plan by a crashed process
are marked `failed (resumable)`; `POST /sessions/:id/resume` starts a turn with a recovery message.
Dangling `tool_use` blocks from the crash window are repaired before the conversation is replayed —
without that, one crash makes a session permanently unusable. Orphaned deploy and commit
confirmations answered after a restart execute directly (with the same permission and confirmation
checks). An orphaned plan approval is recorded on the session, and a plan or `ask_user` answer is
delivered on the next turn as the result of the call that asked, so the model continues from the
answer instead of asking again.

Whether the workspace is dirty — changed after its last validation — is derived from persisted
state (the latest `workspace.file` event against the validation's start time), not from memory,
so validate → stage → restart → Deploy is refused like it should be.

## Observability

Each provider attempt emits persisted `model.started` and `model.finished` events, including
failed/retried calls, fallback models, forced reports and compaction. They carry a call ID, agent,
role-derived phase, purpose, elapsed duration, first observable output time and per-call usage
(null when unknown). Cumulative `session.usage` remains the billing/UI total; do not sum it.
Provider duration includes prefill/network/hidden reasoning and is not a decoding measurement.

The admin session **Timing** tab uses the shared interval analyzer: parallel model and tool spans
are unioned, overlap is shown separately, and delegation/question wrappers do not masquerade as
tool execution. Unattributed time is explicitly unknown rather than inferred idle/model time.
`GET /sessions/:id/export` streams complete persisted events as NDJSON through a fixed sequence
watermark under the normal session access checks. Its manifest names the non-persisted streaming
delta/thinking types; sequence gaps are expected. `tools/audit-long-session.mjs` reads this format
or older Markdown exports after building `@sf-claws/shared`. Old exports cannot supply missing
per-call model timing or agent-level token attribution.

`usage_records` per model call (session, user, client, role, provider, model, tokens, cached tokens,
USD, duration). `tool_invocations` per tool call (tool, ok, duration, result size). `audit_log`
records logins, approvals, org connections, deploys, commits and configuration changes.
`/admin/usage/summary`, `/admin/tools/summary` and `/admin/budget` aggregate them for the console.

## Compile controller and durable recovery

`session_compile_control` persists dirty paths, content hashes, root diagnostics, the repair allowlist,
and the no-progress stop across turns, agent replacements and server restarts. Workspace tools enforce
these gates before writes, including after asynchronous original-file retrieval. Human edits may repair
a stopped session; a successful manual full validation resets the stop. Validation freezes writes and
an in-process org queue serializes validation/deployment submissions. A unique active-checkpoint index
also reserves the org durably across restarts. Attempts are reserved transactionally before submission.
The deployment architecture remains single-process; this is not a distributed worker scheduler.

A timer and model-boundary checks request a dependency-expanded check-only slice at eight dirty files
or ten minutes. Apex companion files must be present; an incomplete group blocks new components until
its companions are supplied. Slice selection currently uses conservative source-name references and
staged schema, not an AST graph. Existing unmanaged Apex-only slices in non-production orgs use Tooling
`MetadataContainer` / `ContainerAsyncRequest(IsCheckOnly=true)` when companion metadata is unchanged.
New/deleted components, schema, changed companion metadata, production, explicit test requests, and
full checks use Metadata API. A missing existing Apex ID falls back to Metadata without creating a stub.
Slice success is explicitly labelled and never satisfies the full-validation deployment gate.

Dependent-class diagnostics are grouped under their named root. While roots remain, agents may edit
only failing components and their direct staged dependencies, and may not introduce new components.
Unchanged failed payloads are refused; two subsequent compiles without fewer root components stop all
agent loops, including paid wrap-up/documentation. Each remote operation archives the staged tree,
controller state, source payload and exact Metadata ZIP (or Tooling member payload), with a checksum.
Comparable compiler regressions quarantine the candidate and atomically restore the prior staged
checkpoint, then stop for manual validation. Both trees remain recoverable. This is NOT org rollback.

`UNKNOWN_EXCEPTION` and lock faults are platform failures, not proof of a code problem or proof of a
specific lock. Check-only payloads retry unchanged after 15s and 45s with ±10% jitter, at most three
submissions including the first. Retry times, job IDs, outcomes and attempt times survive restart.
Auth/quota rejections do not retry. Lost acknowledgements and nonterminal polling failures retain the
org reservation: reconcile the known job/container; never blindly resubmit. Real deployments are
archived but are not automatically resubmitted. Reconciliation never authorizes current workspace
contents; a fresh full check is required. Existing review, approval and fingerprint gates still apply.

## Shared facts and pre-hydration

Before constructing an agent, `pre-hydration.ts` inspects an optional org-local Git checkout at
`DATA_DIR/workspaces/<clientId>/<orgId>` with read-only status, diff and log commands. It never clones,
stashes, checks out, or claims HEAD mirrors Salesforce. Missing Git baselines are recorded as unavailable.
Targets come from explicit API names, page context, staged files and changed Git source: at most eight
per pass, three simultaneous org reads, a 20-second remote-evidence deadline, and one bounded second
pass through `hydrate_context`. Already-issued read-only calls may finish after the hydration deadline;
queued expired reads are not sent. Unrelated/global discovery is never part of pre-hydration.

`session_hydration` stores the evidence manifest outside conversation history (source, access identity,
API version, retrieval time, hash, verified/absent/unavailable status). Compact projections go after the
prompt cache boundary and are refreshed before model iterations, including after compaction and in
replacement agents. Stale evidence is labelled and omitted from previews. The bundle also includes
the request, approved plan, staged schema delta, open roots and spend to date.

Successful describes, metadata reads/listings and content-hashed skills share a bounded LRU cache
(256 entries / 16 MiB, 60-second TTL) keyed by tenant, org, user/access principal, API version, connection
identity, schema revision and resource. Concurrent misses coalesce; callers get isolated copies of the
full result, not a reference to discarded conversation text. Workspace/todo edits do not invalidate
live schema; org mutations and reconnects do. Errors are never cached as absence, and staging refuses
to guess that a component is new after its original-source lookup fails.

Recovery endpoints and operational limits are documented in [HARNESS-RECOVERY.md](HARNESS-RECOVERY.md).
Automatic org-to-Git baseline synchronization, AST graphing and atomic token reservations remain
separate work; this increment does not claim to implement them.

## Security notes

- Extension origin `chrome-extension://*` is CORS-allowed; tokens travel in `Authorization` headers
  except the SSE route, which accepts `?token=` because EventSource cannot set headers.
- Only `SELECT` SOQL is accepted on the query route; anonymous Apex that mutates data additionally
  requires `allowDataModification`.
- Production orgs are `protected` by default; `productionRequiresProMode` is available.
- Rate limiting on auth routes; passwords ≥ 10 characters; tokens revocable; disabling a user
  revokes all their tokens.
- A build-time test fails CI on any unscoped read of a tenant-owned table.
