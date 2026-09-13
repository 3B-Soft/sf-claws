# SF Claws — notes for AI coding agents

- Monorepo (npm workspaces, Node 22). Build order: shared → server → admin-ui → extension.
  `npm run lint && npm run typecheck && npm test` is what CI runs; run all three before pushing.
- Contract first: change `packages/shared/src/*.ts` (zod) before touching server routes or UI code;
  rebuild shared (`npm run build -w @sf-claws/shared`) so the UIs pick up `dist/`.
- Server: Fastify + better-sqlite3, ESM with `.js` import suffixes. Add schema changes as a **new**
  entry in `src/db/migrations.ts` — never edit an applied one. Secrets go through `SecretBox`:
  `encryptFor(clientId, …)` for anything a client owns, `encrypt(…)` for server-wide secrets.
- Agent tools live in `src/agents/tools.ts`. Anything that changes a Salesforce org must go through
  `runtime.gate()` (allow list + user approval) and must accept a plain-language `reason`.
- Every `ToolDef` declares `readOnly`, and declares `concurrencySafe` only when the call is genuinely
  safe beside others in the same turn. Unsafe is the default and it is deliberate: two writes to one
  path, or two gated commands opening competing confirmation cards, are the bugs it prevents.
- Prompt ordering in `src/agents/prompts.ts` is load-bearing. Stable content goes before the cache
  boundary, volatile content after. Moving a volatile section up re-bills the whole prefix each turn.
- Tenant-scoped queries need a scoping predicate; `test/tenant-isolation.test.ts` fails the build
  otherwise. A genuine exception goes in that file's allowlist **with a written reason**.
- UIs: LWC OSS light DOM only (`static renderMode = 'light'` + `<template lwc:render-mode="light">`),
  Tailwind utilities, components under `src/modules/x/`. Build via `tools/vite-lwc-plugin.mjs`.
  Gotcha: `<textarea value={x}>` does not populate — sync it imperatively in `renderedCallback`.
- Colours are **semantic tokens only** (`bg-surface`, `text-content-muted`, `border-line`,
  `brand-500`), defined in each package's `styles.css` from the Salesforce Lightning palette. Never
  a raw `slate-*` or `indigo-*`. Status hues (emerald/rose/amber) keep their names. After any
  styling change run `npm run contrast` — it fails any text under WCAG AA on its real background.
- Tests: `packages/server/test` uses in-memory SQLite, a scripted `FakeProvider` for the LLM and a
  stubbed Salesforce service — extend those rather than calling real APIs. `disablePlanMode(ctx)` in
  the helpers turns off the plan gate for tests that are not about plan mode.
- Client and org `instructions` are always-loaded agent instructions (a CLAUDE.md for a client).
  They go in the cacheable half of the prompt and can never widen what an agent may do — policy and
  the non-negotiable rules decide that.
- The extension reports page context with every message, not only at session start. Anything that
  needs to know where the user is should read it from the session, not cache it.
- Agents are told to take the least-resistance path (`skills/05-least-resistance.md`, a `quality`
  skill so it is inlined for every role): configuration before automation, Flow before Apex, extend
  before duplicate, root cause before symptom, and the lead agent does trivial work itself rather
  than spawning a swarm for one field. Apply the same rule to this codebase.
- `SYSTEM_CACHE_BOUNDARY` in `src/ai/types.ts` is what makes the prompt ordering real: the Anthropic
  provider splits the system text there and caches only the stable half. Keep volatile content below
  the marker, and never let a section that changes per message drift above it.
- Read `docs/ARCHITECTURE.md` before changing the agent runtime, and `docs/TENANCY.md` before
  changing anything that touches more than one client's data.
