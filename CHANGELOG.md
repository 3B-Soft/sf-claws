# Changelog

All notable changes to SF Claws are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `npm run typecheck` failed on a clean checkout (and in CI, which typechecks before building)
  because the server resolves `@sf-claws/shared` from its unbuilt `dist/`. The script now builds
  shared first.
- Opening a session in the side panel threw `ReferenceError: reportPendingConfirmations is not
  defined` and rendered an empty transcript. Two call sites were left behind by a rename; the
  correct `reportAwaiting()` was already being called beside both.

### Added

- `npm run build:store -w @sf-claws/extension` produces the Chrome Web Store upload, and
  `tools/store-assets.mjs` generates the listing images from the real screenshots. See
  `docs/PUBLISHING.md`.

## [0.0.1] - 2026-09-13

First public release. Everything below was built by 3B for its own operations team before being
open sourced, with AI coding agents doing a large share of the implementation under review.

### Added

- **Chrome side panel** (`packages/extension`): chat, plan, changes with diffs, org explorer,
  notes and GitHub tabs. Reports the current Salesforce page with every message. Pairs to a
  self-hosted server with a one-time code.
- **Control plane** (`packages/server`): Fastify + SQLite. Users with super admin, admin and user
  roles; clients, orgs and per-client GitHub repositories; model providers (Anthropic, OpenAI,
  DeepSeek, DeepInfra) with per-role bindings and prices; skills; permission policies; spend
  ceilings per turn, session and client-month; audit log.
- **Agent runtime**: plan mode, analyst, builder, reviewer, documentation and summariser roles,
  a shared scratchpad, `checkOnly` validation until clean, a human approval gate for every
  impactful command, commit strategies, and session documentation stored as searchable memory.
- **Knowledge sources**: documentation and product source repositories researched before
  answering, documentation first and code as ground truth.
- **Admin console** (`packages/admin-ui`): providers and models, clients, members, policies,
  standing instructions, sessions with full traces and per-role spend.
- **Tenant isolation**: tool calls read their target org from the session, per-tenant
  encryption under a server master key, and a build-time test that fails CI on any unscoped read
  of tenant-owned data.
- Docs: architecture, tenancy, deployment, admin guide, user guide, security policy,
  contributing guide and code of conduct. Docker image and compose file. CI running lint,
  typecheck, build and tests.

[0.0.1]: https://github.com/3B-Soft/sf-claws/releases/tag/v0.0.1
