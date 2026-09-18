# WP0: measured baseline and telemetry delivery

Reproduction: `npm run build -w @sf-claws/shared`, then
`node tools/audit-long-session.mjs _long_session_logs/events_raw.md`.
The same script accepts the new session NDJSON export or a JSON event array.

The supplied historical export yields 103m 24.331s active time and 19m 11.303s in explicit
question/plan waits. Leaf-tool intervals account for 7m 34.935s of active wall time after
unioning overlap and excluding parent delegation and approval wrappers. The remaining
95m 49.396s is **unattributed**, not measured decoding or idle time. No per-call model spans
exist in this export, so tokens per agent and phase are unavailable. All 2,367,470 uncached
input/output tokens remain unattributed to agents; cached input is also unavailable per agent.

There were three concurrent child-agent lifetimes during the initial investigation. Subsequent
builders ran serially. Lifetimes include their tool calls and waits; they do not measure concurrent
model inference. The revised plan's decoding hypothesis remains plausible but unproven. These
measurements provide no reason to reorder compile-early and output reduction.

```mermaid
gantt
    title Historical child-agent lifetimes (UTC, September 15)
    dateFormat YYYY-MM-DDTHH:mm:ss
    axisFormat %H:%M
    section Investigation
    Researcher 1 :2026-09-15T16:38:59, 2026-09-15T16:43:03
    Analyst 1 :2026-09-15T16:38:59, 2026-09-15T16:42:13
    Analyst 2 :2026-09-15T16:38:59, 2026-09-15T16:44:54
    Researcher 2 :2026-09-15T16:51:00, 2026-09-15T16:53:31
    Analyst 3 :2026-09-15T17:01:30, 2026-09-15T17:06:48
    Analyst 4 :2026-09-15T17:11:07, 2026-09-15T17:14:44
    section Implementation
    Backend first pass :2026-09-15T17:23:01, 2026-09-15T17:43:39
    Progress repair :2026-09-15T17:46:14, 2026-09-15T18:03:24
    Delivery repair :2026-09-15T18:03:24, 2026-09-15T18:23:40
    Metadata builder :2026-09-15T18:23:40, 2026-09-15T18:33:13
    Reviewer :2026-09-15T18:33:56, 2026-09-15T18:40:58
```

New runs record paired model events for each provider attempt, including fallback, retry,
compaction and forced-report calls. Failed calls retain unknown usage rather than zero usage.
The Timing tab displays agent lifetimes, wall-time categories, per-agent output, and token totals
by agent/phase/purpose. Phase attribution follows agent role and plan approval, rather than an
extra model call. The export is lossless for persisted events; transient text/thinking chunks are
explicitly excluded in its manifest. Existing historical gaps cannot be repaired retroactively.

WP0 ships without changing the planner, compile policy, budgets, or deployment behavior. WP1 is
the next implementation slice: compile coherent groups early, prevent expansion while root
errors remain, and bound repair by progress. The deferred graph, org sync and phased-release
controller remain deferred as requested in the revised plan.
