# Contributing to SF Claws

Thanks for looking. This document is the short version of how the codebase is put together and what
a reviewable change looks like.

## Getting set up

```bash
npm install
npm run build -w @sf-claws/shared          # the contract package; UIs read its dist/
cp packages/server/.env.example packages/server/.env
# fill MASTER_KEY, JWT_SECRET, SF_CLIENT_ID/SECRET
npm run dev:server                          # http://localhost:8787
npm run dev:admin                           # http://localhost:5173
npm run build -w @sf-claws/extension        # load packages/extension/dist as an unpacked extension
```

Before pushing:

```bash
npm run lint && npm run typecheck && npm test
```

CI runs exactly these. A red build is not a review comment away from green — fix it first.

## The shape of the codebase

Four workspaces, built in this order because each depends on the previous:

| Package | What it is |
|---|---|
| `packages/shared` | The contract: zod schemas for entities, REST routes, session events, SFDX path helpers. |
| `packages/server` | Fastify + SQLite control plane, agent runtime, Salesforce and GitHub integration. |
| `packages/admin-ui` | Admin console (LWC OSS + Tailwind + Vite). |
| `packages/extension` | Chrome MV3 side panel (LWC OSS + Tailwind + Vite). |

`docs/ARCHITECTURE.md` explains how a change flows from a user message to a deployed component.
`docs/TENANCY.md` explains the isolation model. Read both before changing the agent runtime.

## Conventions that are not negotiable

These exist because breaking them causes a specific, previously observed failure.

**Contract first.** Change `packages/shared/src/*.ts` before the server or a UI, and rebuild shared
so the UIs see it. Both UIs and the server import the same zod schemas; if they drift, the failure
shows up at runtime in a user's browser rather than in CI.

**Migrations are append-only.** Add a new entry to `packages/server/src/db/migrations.ts`. Never
edit one that has been applied — a deployed database has already run it and will not run it again.

**Everything that touches a Salesforce org goes through the gate.** Any tool that changes org data
or metadata must call `runtime.gate()`, must accept a plain-language `reason`, and must be on
`PolicyRules.impactAllowList`. This is the product's central safety property. A tool that mutates an
org without a gate will not be merged.

**Tools declare their own safety.** Every `ToolDef` sets `readOnly`, and sets `concurrencySafe` only
when the call genuinely can run beside others in the same model turn. The default is unsafe on
purpose. Two writes to one workspace path, or two gated commands opening competing confirmation
cards, are the bugs this prevents.

**Tenant scoping is enforced by a test.** Every read of a tenant-owned table needs a scoping
predicate. `test/tenant-isolation.test.ts` fails the build otherwise. If you have a genuine
cross-tenant read, add it to the allowlist there *with a written reason* — a second test fails if
that entry ever goes stale.

**Secrets go through `SecretBox`.** Client-owned secrets (Salesforce and GitHub tokens) use
`encryptFor(clientId, ...)` so they are encrypted under that tenant's own data key. Server-wide
secrets use `encrypt(...)`.

**LWC OSS light DOM only.** `static renderMode = 'light'` plus `<template lwc:render-mode="light">`,
Tailwind utilities, components under `src/modules/x/`. Shadow DOM breaks the Tailwind build.

**Semantic colour tokens, never raw hues.** `bg-surface`, `text-content-muted`, `border-line`,
`brand-500` — defined once in each package's `styles.css`, following the Salesforce Lightning
palette so the UI does not look foreign beside the org it manages. A `bg-slate-900` or a
`text-indigo-400` is a bug: this codebase has already changed theme once, and the raw classes were
the entire cost of it. Status hues (emerald, rose, amber…) keep their names, because "this is an
error" is a meaning, not a colour choice.

Run `npm run contrast` after any styling change. It walks every text node on every screen against
its real composited background and fails anything under WCAG AA. A theme change breaks text in ways
a screenshot review does not catch — a label at #94a3b8 is still visible on #0f172a and invisible on
white — and the audit is faster than looking.

## Tests

`packages/server/test` runs against in-memory SQLite with a scripted `FakeProvider` for the model and
a stubbed Salesforce service. Extend those rather than reaching for a real API — a test that needs
network access will not run in CI and will be deleted.

Write the test that would have caught the bug. For a new tool, that means a scripted provider run
that exercises the tool through the real agent loop, not a direct call to `run()`.

## Commit and PR style

- Explain what changed and why. "Fix bug" tells a future reader nothing; the reason a line exists is
  the part that is expensive to recover later.
- One concern per PR. A rename plus a behaviour change is two PRs.
- If you change agent behaviour, say what you expect the model to do differently, and how you
  checked. Prompt changes are code changes with worse observability.

## What we are unlikely to accept

- Giving agents shell access, a filesystem or a code interpreter. The safety model depends on every
  org-affecting action being a typed, gated tool.
- Removing a confirmation gate, a policy check or a spend ceiling to make a workflow smoother.
- Vendor-specific content in default seed data. A fresh clone should carry no deployment's private
  conventions — configure those in your own deployment's database instead.
