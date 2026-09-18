# Architecture Snapshot

## Repository Map

115 modules, 4286 symbols, grouped by area. Every module is in `facts.jsonl`, or query_facts(kind="module").

| Area | Modules | Symbols | Languages |
|------|---------|---------|-----------|
| `packages` | 114 | 4197 | typescript |
| `tools` | 1 | 89 | typescript |

Largest modules:
- `packages/server/src/agents` — 366 symbols (typescript)
- `packages/server/src/db/repos` — 270 symbols (typescript)
- `packages/shared/src` — 227 symbols (typescript)
- `packages/extension/src/lib` — 189 symbols (typescript)
- `packages/admin-ui/src/modules/x/sessionDetailPage` — 107 symbols (typescript)
- `packages/server/src/salesforce` — 107 symbols (typescript)
- `packages/extension/src/modules/x/chatThread` — 106 symbols (typescript)
- `packages/extension/src/modules/x/changesTab` — 96 symbols (typescript)
- `packages/admin-ui/src/lib` — 95 symbols (typescript)
- `tools` — 89 symbols (typescript)
- `packages/extension/src/modules/x/transcriptItem` — 87 symbols (typescript)
- `packages/extension/src/modules/x/soqlBuilder` — 85 symbols (typescript)
- `packages/server/src/ai` — 68 symbols (typescript)
- `packages/server/src/knowledge` — 64 symbols (typescript)
- `packages/admin-ui/src/modules/x/eventCard` — 62 symbols (typescript)
- `packages/extension/src/modules/x/githubTab` — 61 symbols (typescript)
- `packages/admin-ui/src/modules/x/githubTab` — 57 symbols (typescript)
- `packages/extension/src/modules/x/metadataBrowser` — 57 symbols (typescript)
- `packages/extension/src/modules/x/toolStep` — 51 symbols (typescript)
- `packages/extension/src/modules/x/appHeader` — 50 symbols (typescript)

## Extraction Quality

- Files parsed: **258** / 390 seen (38 file(s) + 9 directory tree(s) skipped by ignore globs)
- Parse errors: 0

## Architecture Pattern

_No specific architecture pattern detected._

## Entry Points

170 handlers, 15 shown:
- **handler**: `packages/admin-ui/src/lib.setUnauthorizedHandler` (packages/admin-ui/src/lib/api.js)
- **handler**: `packages/extension/src/lib.normalizeServerUrl` (packages/extension/src/lib/storage.js)
- **handler**: `packages/extension/src/lib.saveServerUrl` (packages/extension/src/lib/state.js)
- **handler**: `packages/server.VitestConfig` (packages/server/vitest.config.ts)
- **handler**: `packages/server.VitestEvalConfig` (packages/server/vitest.eval.config.ts)
- **handler**: `packages/server/src.createContext` (packages/server/src/index.ts)
- **handler**: `packages/server/src.createLogger` (packages/server/src/logger.ts)
- **handler**: `packages/server/src.loadConfig` (packages/server/src/config.ts)
- **handler**: `packages/server/src.loadDotEnv` (packages/server/src/config.ts)
- **handler**: `packages/server/src.redactUrl` (packages/server/src/logger.ts)
- **handler**: `packages/server/src.serializeRequest` (packages/server/src/logger.ts)
- **handler**: `packages/server/src/agents.answerOrphanedQuestions` (packages/server/src/agents/conversation.ts)
- **handler**: `packages/server/src/agents.applyCompileResult` (packages/server/src/agents/compile-control.ts)
- **handler**: `packages/server/src/agents.backoffMs` (packages/server/src/agents/backoff.ts)
- **handler**: `packages/server/src/agents.budgetTurnResults` (packages/server/src/agents/budget.ts)
- … and 155 more (query_facts(kind="route") for all)
- **main**: `packages/server/src.main` (packages/server/src/index.ts)
268 routes, 15 shown:
- **route** DELETE `/admin/agents/:id` (packages/server/src/http/routes/admin.ts)
- **route** DELETE `/admin/knowledge/:id` (packages/server/src/http/routes/admin.ts)
- **route** DELETE `/admin/models/:id` (packages/server/src/http/routes/admin.ts)
- **route** DELETE `/admin/providers/:provider` (packages/server/src/http/routes/admin.ts)
- **route** DELETE `/clients/:clientId/github` (packages/server/src/http/routes/github.ts)
- **route** DELETE `/clients/:clientId/members/:userId` (packages/server/src/http/routes/clients.ts)
- **route** DELETE `/clients/:id` (packages/server/src/http/routes/clients.ts)
- **route** DELETE `/me/providers/:provider` (packages/server/src/http/routes/auth.ts)
- **route** DELETE `/orgs/:orgId` (packages/server/src/http/routes/orgs.ts)
- **route** DELETE `/projects/:id` (packages/server/src/http/routes/projects.ts)
- **route** DELETE `/sessions/:id/permissions/:command` (packages/server/src/http/routes/sessions.ts)
- **route** DELETE `/sessions/:id/workspace/file` (packages/server/src/http/routes/sessions.ts)
- **route** DELETE `/sessions/{}/permissions/{}` (packages/extension/src/lib/api.js)
- **route** DELETE `/skills/:id` (packages/server/src/http/routes/skills.ts)
- **route** DELETE `/tasks/:id` (packages/server/src/http/routes/projects.ts)
- … and 253 more (query_facts(kind="route") for all)

## Routes

268 routes, grouped by path prefix. query_facts(kind="route") for all of them.

| Prefix | Routes | Methods | Example |
|--------|--------|---------|----------|
| `/sessions` | 75 | DELETE, GET, PATCH, POST, PUT | `/sessions` |
| `/admin` | 65 | DELETE, GET, PATCH, POST, PUT | `/admin/agents` |
| `/clients` | 39 | DELETE, GET, PATCH, POST, PUT | `/clients` |
| `/orgs` | 35 | DELETE, GET, PATCH, POST | `/orgs` |
| `/auth` | 20 | GET, PATCH, POST | `/auth/change-password` |
| `/skills` | 10 | DELETE, GET, PATCH, POST | `/skills` |
| `/tasks` | 7 | DELETE, GET, PATCH, POST | `/tasks` |
| `/projects` | 6 | DELETE, GET, PATCH, POST | `/projects` |
| `/me` | 3 | DELETE, GET, PUT | `/me/providers` |
| `/docs` | 2 | GET | `/docs/:docId` |
| `/health` | 2 | GET | `/health` |
| `/oauth` | 1 | GET | `/oauth/salesforce/callback` |
| `/projects{})}` | 1 | GET | `/projects{})}` |
| `/runTestsAsynchronous` | 1 | POST | `/runTestsAsynchronous` |
| `/services` | 1 | GET | `/services/data` |

## Dependency Rules

- `packages/admin-ui/src/modules/x` -> `packages/admin-ui/src/lib`
- `packages/extension/src/modules/x` -> `packages/extension/src/lib`
- `packages/extension` -> `packages/extension/src/lib`
- `packages/server/src/db` -> `packages/server/src/agents`
- `packages/server/src/db` -> `packages/server/src/db`
- `packages/server/src/db` -> `packages/server/src/lib`
- `packages/server/src/http` -> `packages/server/src/agents`
- `packages/server/src/http` -> `packages/server/src/auth`
- `packages/server/src/http` -> `packages/server/src/http`
- `packages/server/src/http` -> `packages/server/src/knowledge`
- `packages/server/src/http` -> `packages/server/src/lib`
- `packages/server/src/http` -> `packages/server/src/salesforce`
- `packages/server/src` -> `packages/server/src/auth`
- `packages/server/src` -> `packages/server/src/github`
- `packages/server/src` -> `packages/server/src/http/routes`
- `packages/server/src` -> `packages/server/src/lib`
- `packages/server/src` -> `packages/server/src/salesforce`
- `packages/server` -> `packages/server/src/db/repos`
- `packages/server` -> `packages/server/src/db`
- `packages/server` -> `packages/server/src/http`
- `packages` -> `tools`

## Critical Modules

| Module | Fan-In | Fan-Out | Criticality |
|--------|--------|---------|-------------|
| `packages/admin-ui/src/lib` | 42 | 0 | high |
| `packages/extension/src/lib` | 24 | 0 | high |
| `packages/server/src` | 0 | 8 | medium |
| `packages/server/src/http` | 2 | 6 | medium |
| `packages/server/src/lib` | 6 | 0 | medium |
| `packages/server/src/db` | 2 | 3 | medium |
| `packages/server` | 0 | 3 | low |
| `packages/server/src/agents` | 2 | 0 | low |
| `packages/server/src/auth` | 2 | 0 | low |
| `packages/server/src/salesforce` | 2 | 0 | low |

---

*Generated at 2026-09-18T12:13:03Z in 613.214958ms. 6097 facts, 85 insights.*
