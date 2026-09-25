# Compliance matcher session investigation

Session: `ses_muebu0hwBVdN6LKIb24P`. Evidence: the supplied NDJSON export, ending at sequence 56340. It contains 295 persisted events; the larger sequence numbers include ephemeral streaming events that were not retained. Times below are UTC on 2026-09-23 (add three hours for Sofia).

## What happened

| Time / sequence | Evidence | Consequence |
| --- | --- | --- |
| 16:46:16 / 22914 | Only `agent.spawned` event: `doc_writer` | No builder, explorer, planner or verifier was launched. There are no `run_subagent` tool calls. The documentation worker was the automatic runtime fallback. |
| 16:55:57 / 54039 | Lead assigns every implementation todo to `orchestrator` | The task list tracked work but did not delegate it. All ten `write_workspace_file` calls came from the lead. |
| 16:56:42 onward | Three calls to nonexistent `write_worksheet_file` | Avoidable tool-name errors before the lead corrected itself. |
| 16:58:09 / 54435 | Automatic slice validation: 3/4 components; test identifier too long | The planned test name had 43 characters. The error was genuine and actionable. |
| 16:58:46 / 55082–55089 | Old test and companion removed; both renamed writes return `ok: false` | The controller still retained the removed component's root error. Its prohibition on new components rejected the renamed test. The test was **not** successfully restaged, despite the visible staging cards. |
| 16:59:24 / 56309 | Lead validates controller-only slice using `RunLocalTests` | 1 component, 13 tests, 54% reported coverage, `failures: []`. The intended new test was absent. |
| 16:59:24 / 56311 | Persisted stop: “Salesforce unknown failure” | Coverage diagnostics never entered the repair loop. The stop prevented subsequent tool execution and worker launches. |
| 17:00:41, 17:03:39, 17:49:25 | Full validations 3–5: 3 components, 13 tests, 54%, empty failures | These have no associated agent validation calls. They are consistent with panel/manual runs, not a model repeatedly invoking validation. The route returned results without initiating repair. |
| 17:23:08 / 56329–56333 | User asks to increase coverage; session immediately fails again | The persisted compile stop prevented the model from acting. Resume also refused while that stop remained. |

The export shows 24 completed model calls, about 18.4 minutes of measured model request time, 1,808,237 input tokens, 83,052 output tokens, and 151,680 cached input tokens as recorded by the application. Maximum concurrent model calls: one. The timing analyzer's large unattributed active interval is not proof that the model was working: manual validation emitted “running” progress without a terminal session-status event.

Salesforce's supplied deployment screen reports 53% coverage. The application reports 54% from aggregated run coverage. Those are different observations; the old event export lacks the raw Salesforce response needed to reconcile them exactly.

## Causes and changes

- Delegation was prompt advice, not a code-writing boundary. Removing the trivial-work sentence alone could not enforce delegation. Code staging now rejects orchestrator writes to Apex, LWC, Aura and Flow with a builder instruction. The lead prompt requires concrete builder briefs and builder-led repairs. Simple metadata work remains available to the lead.
- Removed components left stale compile roots, blocking a renamed replacement. Unstaging now prunes roots for components no longer staged. Test/coverage failures allow new Apex tests, and Apex slices include staged tests and companion files.
- Salesforce coverage warnings were retained separately but omitted from failures and failure classification. They now become repair diagnostics, preserving exact warning text. A failed test run with low aggregate coverage and otherwise empty diagnostics also produces an explicit diagnosis. The original terminal response is archived for new attempts.
- The policy coverage diagnostic was added only when Salesforce returned success. It now applies to failed results too. Coverage repairs are not treated as infrastructure failures. Changed diagnostics count as progress; identical failed agent payloads remain blocked.
- Resume and new messages recover the specific historical low-coverage “unknown failure” stop using persisted evidence. Resume includes the latest validation in the lead's context. Explicit Resume can restart an exhausted, bounded compiler repair budget while retaining the unchanged-payload restriction. Uncertain remote operations and real infrastructure stops remain protected.
- Manual validation delivers actionable failures to the agent for builder repair and revalidation. It does not authorize deployment. Repeated unchanged failed manual payloads reuse the result while repair is available. Terminal validation status and interrupted tasks no longer remain visibly active. Resume clients no longer overwrite an already-finished turn with optimistic “running” state; error text wraps.
- `read_validation_result` gives agents session-scoped access to paths, test selection, archived attempts, coverage warnings and raw results.

## Downloads

- Workspace/Changes: **Export workspace ZIP** / **Export ZIP**, containing staged source, originals and a manifest with deletions. This is an investigation snapshot, not a deploy-ready package.
- Validation cards: **Download validation details**, including payload/checkpoint and attempts.
- Admin session timing: **Download full audit ZIP**. Available to authorized client/platform admins, respecting client membership. Includes retained events, visible conversations and decisions, worker objectives/reports, task state, tool evidence, source, validations, and artifacts. New audit records preserve visible messages and full tool inputs/results across compaction. Private model reasoning and provider raw blocks are excluded.

Historical ephemeral reasoning, clipped tool inputs, and overwritten conversation history cannot be reconstructed. Each audit manifest states these limits. This investigation made no live Salesforce changes. The server must run the updated code, and clients must load the rebuilt UI, before the existing session can use the repaired Resume path.
