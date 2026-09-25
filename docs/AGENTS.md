# Agents and coordination tools

SF Claws organizes agents by the work they perform. Salesforce is their operating environment;
component-specific conventions belong in skills and tool contracts. Prompts are maintained as
individual definitions under `packages/server/src/agents/built-in/`, while `prompts.ts` assembles
them with policy, skills, client/org instructions, and dynamic session context. Stable sections
remain before the provider cache boundary. Assignment text remains a user message.

## Agent types

| Type | Purpose | Capabilities |
| --- | --- | --- |
| `orchestrator` | Understand the request, coordinate work, integrate results | User conversation, delegation, staging, gated operations |
| `general` | Investigation and implementation across component technologies | Reads, staged changes, existing gated builder operations |
| `explore` | Find files and trace existing behavior | Reads and coordination; no workspace or org writes |
| `plan` | Architecture, sequencing, dependencies and acceptance checks | Reads and coordination; cannot implement or approve its own plan |

The delegation tool offers exactly three worker types: `explore`, `plan`, and `general`.
The orchestrator owns user interaction and synthesis. Explore defaults to Haiku with low effort
for new installations; existing model bindings and the explicit DeepSeek seed profile are retained.
Summarization is an internal service, not a delegatable worker type. Legacy definitions and model
bindings remain readable for persisted sessions and custom specialists.

Repository investigations now launch Explore with the existing repository scope and read budget.
Documentation belongs to the orchestrator; the documentation fallback uses General-purpose.
A configured independent-review policy is still enforced, using a General-purpose assignment with
an unchanged-workspace verdict. A worker that changes files cannot certify those edits as an
independent review. The prompt no longer mandates a Verify agent or duplicate validation.

## Reference design adaptations

Inspected the reference source under `claude-code-leak/src/tools/AgentTool/`: the built-in
`exploreAgent.ts`, `planAgent.ts`, and `generalPurposeAgent.ts`, plus `prompt.ts`, `runAgent.ts`,
`TaskStopTool/TaskStopTool.ts`, and `SendMessageTool/prompt.ts` in the sibling tools directories.
Explore performs fast read-only searches and defaults to Haiku; Plan researches a strategy without
editing; General-purpose executes multi-step work and returns a concise report to the caller.

Fresh workers need a self-contained brief. Foreground calls return a report; background workers
report completion automatically. Stop requests use an abort signal, and messages are delivered at
model boundaries. SF Claws already implements these lifecycle operations with persisted worker IDs,
reports, messages, and resumable transcripts. Unlike the reference CLI, it has no shell processes
or worktree isolation; background work remains limited to read-only roles sharing the workspace.

Forking is explicit (`forkContext: true`) and retains child-role tool restrictions and policy.
Outstanding calls receive placeholder results in copied history; provider reasoning is removed.
Workers cannot recursively delegate. Messages and cancellation do not grant approval or undo edits.

## Tools

Tools use the existing snake_case naming convention. Their descriptions live in `tool-prompts.ts`;
implementations are separated into `task-tools.ts`, `search-tools.ts`, and `web-tools.ts`.

| Tool | Behavior |
| --- | --- |
| `task_create` | Create a pending session work item with subject, description and optional activeForm |
| `task_get` / `task_list` | Read requirements, owners and unresolved dependencies |
| `task_update` | Change status, claim ownership, edit requirements, merge metadata, add dependencies or delete an item |
| `task_output` | Read an agent run's current status/report; optionally wait up to 60 seconds |
| `task_stop` | Parent requests cooperative cancellation of a running worker |
| `send_message` | Queue a message to an agent ID, `parent`, or `*`; parent can resume a finished worker |
| `brief` | Publish a normal/proactive user update, with optional staged-path attachment references |
| `glob` | Paginated filename matching in workspace or a named linked repository |
| `grep` | Guarded JavaScript regex search, path filters, content/files/count modes and multiline support |
| `read_source_file` | Read a workspace/repository path with line-numbered paging |
| `web_search` | Public web search with citations and domain filtering |

Work item IDs and worker IDs are distinct. Creating a work item does not launch an agent, and
deleting an item does not stop a worker. The pre-existing `update_task` still updates the external
project task linked to the session; it is separate from this session's work board.

Task edits are synchronous SQLite transactions. Dependencies must belong to the session, cannot
cycle, and must complete before dependent work starts. Conflicting ownership claims fail. Metadata
values of null remove keys. Use `metadata.blocker` to explain blocked work while keeping its task
status open; the UI checklist shows it as blocked. The board projects into the existing persisted
checklist and `todo.updated` events. Once a board exists, `todo_write` cannot overwrite it.
Successful full-workspace validation reconciles narrowly identified validation steps in both stores
and emits `todo.updated`. Test-required steps need observed tests with zero failures; slice checks,
failed checks, compound deploy steps, and manual acceptance work are not auto-completed. Task-board
entries retain the Salesforce validation ID as evidence. Other checklist wording remains the
orchestrator's responsibility.

`run_subagent` defaults to foreground execution. `runInBackground: true` is accepted for read-only
roles only; staged implementations share a workspace and remain foreground to avoid write races.
At most four managed workers run concurrently per session. Reports are delivered automatically and
the parent synthesizes them before the turn closes. Messages arriving during an in-flight model
call are consumed at the next model boundary, including before a worker exits on a final answer.
Use `send_message` with `resume: true` for follow-up work; saved worker conversations survive turns.
Only a worker's parent may resume or stop it. There is no cross-session messaging.

Cancellation does not roll back changes. Protected operations already in flight still finish and
record their results. A server restart marks interrupted workers failed; they can be resumed from
their saved transcript. Session tasks, worker reports, and queued messages are stored in
`session_agent_state`, scoped by session ID and deleted with the session. Migration is append-only.

## Search scope and configuration

`glob`, `grep`, and `read_source_file` default to staged workspace files. Pass `repo` with the name
of a linked repository to inspect its snapshot. Repository-bound Explore workers cannot switch to a
different source. Search does not enumerate live org metadata: use the existing org tools for that.
Paths are sorted alphabetically, since snapshots lack trustworthy file modification times.
Glob syntax supports `**`, `*`, and `?`, including a globstar matching zero directories; extended
shell brace expansion is not supported. Grep uses the existing bounded search engine, not ripgrep.
Search results report paging, snapshot omissions, and engine limits; a no-match is not proof that
an incomplete snapshot contains no relevant implementation.

Set `BRAVE_SEARCH_API_KEY` in the server environment to enable public search. Without it,
`web_search` returns a clear configuration error. No new LLM-provider subscription is assumed.
Queries go to a fixed HTTPS endpoint, are cancellable, and time out after 15 seconds. Domain filters
are applied both to the query and to returned URLs. Search results are untrusted snippets, and the
prompt requires source links rather than invented citations. The implementation follows the
[Brave Web Search API documentation](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started).
Search-provider charges are separate from the runtime's LLM token-cost accounting.

`brief` publishes through the existing conversation event channel; ordinary final answers remain
visible too. Attachments are references to validated staged paths, not uploads of arbitrary files.
Use existing question/approval tools for user decisions. Messages and tasks never grant permissions.

## Verification

`test/agent-structure.test.ts` covers capabilities, tool schemas, dependency transactions, ownership,
isolation, search, mocked web search, brief events, worker context retention, cancellation, incoming
messages, forks, background completion, plan gating, and restart recovery. Existing runtime,
policy, tenancy, prompt-cache, and deployment tests remain relevant to this architecture.
