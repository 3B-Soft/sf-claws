# @sf-claws/admin-ui

Central admin console for the SF Claws control plane. Single-page app built with LWC Open Source (light DOM) + Tailwind v4 + Vite, talking to the server REST API (`/api/v1`) and the session SSE stream.

## Run

```bash
bun run --filter @sf-claws/admin-ui dev     # http://localhost:5173, proxies /api and /oauth to :8787
bun run --filter @sf-claws/admin-ui build   # dist/ (served by the server when PUBLIC_URL / static hosting is configured)
bunx --bun vite preview --port 4174     # serve dist/ locally
```

API base URL: same origin by default. Override with `window.SF_CLAWS_API_BASE` (set before `main.js` runs) or `localStorage['sfclaws.apiBase']` (editable on the Settings page). The JWT lives in `sessionStorage['sfclaws.token']` (per tab, gone when the tab closes; a token an older build left in `localStorage` is migrated once and removed); UI prefs (sidebar) in `localStorage['sfclaws.prefs']`.

## Routes (hash router, `src/lib/router.js`)

| Route | Screen | Roles |
| --- | --- | --- |
| `#/login`, `#/register` | Sign in / create account. Shows the `setupRequired` banner from `/health`; "awaiting approval" state when register returns `pending:true` or login answers 403 `USER_PENDING`. | anonymous |
| `#/` | Dashboard: `/admin/stats` tiles, recent sessions, quick links | all |
| `#/users` | Approve (choose role) / disable / enable / edit role + uiMode; pending users highlighted | admin+ |
| `#/ai` | Providers (set/replace key, test connection), models CRUD, role → model bindings | superadmin |
| `#/clients`, `#/clients/:id?tab=orgs\|github\|skills\|instructions\|policy\|projects` | Client list + detail tabs | superadmin |
| `#/skills`, `#/skills/:id` (`new` or id) | Global skills list + editor (markdown, live preview, role targeting) | superadmin |
| `#/knowledge` | Knowledge sources (docs corpora, source repos) and admin-defined specialists | superadmin |
| `#/policy` | Global PolicyRules (same editor as the client Policy tab) | superadmin |
| `#/sessions`, `#/sessions/:id?tab=…` | All sessions (admin, `/admin/sessions`) or own (`/sessions?mine=1`); detail with live SSE | all |
| `#/usage` | Usage summary with groupBy, date range, bar chart, totals | admin+ |
| `#/audit` | Audit log | admin+ |
| `#/settings` | Profile (`PATCH /auth/me`), change password, pro/visual mode, API base | all |
| `#/pair?code=XXXX` | Device pairing (`POST /auth/device/approve`). `/pair?code=` (path form) is rewritten to the hash route in `main.js`; the page also reads `code` from `location.search`. | all |
| `#/oauth-result?ok=1\|0&orgId=&message=` | Landing page after the Salesforce OAuth callback | all |

Role gating lives in `src/lib/rbac.js` (`ROUTE_ACCESS`, `navForUser`).

## Structure

```
src/main.js            entry: registers the LWC sanitizeHtmlContent hook, mounts <x-app>
src/styles.css         Tailwind + design tokens + component classes (.card, .btn-*, .table, .prose-x, .diff-*)
src/lib/api.js         fetch wrapper (base URL, token, ApiError{status,code}) + typed helpers per route
src/lib/sse.js         EventSource client with reconnect from `after=` seq; listens to every named event type
src/lib/transcript.js  SessionEvent[] -> render model (blocks, agents, todos, notes, limits, pending confirmations)
src/lib/router.js      hash router + routeStore, navigate(), setQuery()
src/lib/store.js       tiny reactive store; authStore, toasts, confirm() dialog, prefs
src/lib/format.js      dates, tokens, USD, durations
src/lib/diff.js        jsdiff line diffs + unified patch parsing for the diff viewer
src/lib/markdown.js    marked + HTML sanitizer
src/lib/constants.js   enums mirrored from @sf-claws/shared, role/colour meta, icons
src/modules/x/*        LWC components (light DOM). Pages: *Page; client tabs: orgsTab, githubTab, policyTab,
                       projectsTab; session: transcript, eventCard, toolCard, agentSwarm, todoPanel, notesPanel,
                       validationPanel, confirmationCard, limitsGauge, workspaceTab, deploysTab, docsTab,
                       usageRecordsTab; primitives: shell, sidebar, topbar, toast, confirmDialog, modal, badge,
                       icon, dataTable, formField, tabs, pageHeader, statCard, skeleton, emptyState, errorState,
                       markdown, jsonTree, diffViewer, usageChart, skillEditor, skillsList, modelForm,
                       providerCard, roleBindings, branchCompare.
```

LWC rules used throughout: `static renderMode = 'light'` + `<template lwc:render-mode="light">`, getters for derived values, `data-*` attributes to identify items, class strings built in JS. `x-form-field` wraps every input (`change` event with `{name, value}`); `<textarea>` values are synced in `renderedCallback` because LWC rejects a `value` attribute on textareas.

## Session transcript conventions

`src/lib/transcript.js` reduces the event stream into blocks rendered by `x-event-card`:

- `assistant.*` -> chat bubbles (orchestrator primary, sub-agents collapsed under a role chip); `assistant.delta` streams into one bubble per `messageId`.
- `agent.spawned/finished` -> `x-agent-swarm`; `todo.updated` -> `x-todo-panel` (○ ◐ ● ⊘ + progress bar).
- `tool.call/result` -> `x-tool-card` with renderers for `soql_query` (table), `describe_sobject` (field list), `list_metadata` (chips), `read_metadata` (XML), `write_workspace_file` (file chip + diff link); JSON tree in pro mode.
- `deploy.validation` -> `x-validation-panel`; `confirmation.requested` -> `x-confirmation-card` (deploy/commit cards, or the APPROVAL CARD for `kind: 'command'`: Why = description, What = command + Apex code block / key-value table; buttons approve / approve_session / deny -> `POST /sessions/:id/confirm`).
- `org.limits` -> `x-limits-gauge`; `policy.blocked` -> rose "Blocked by policy" notice; `note.written` -> link to the Notes tab (`GET /sessions/:id/notes`).
- `session.status` failed + message "resumable" -> Resume banner (`POST /sessions/:id/resume`). Session permissions (`GET/DELETE /sessions/:id/permissions/:command`) show as revocable chips.
- Pro mode (user or session `uiMode`, toggle in the header): raw event JSON tab, editable workspace XML (`PUT /sessions/:id/workspace/file`), raw tool input/output.

Live updates: while the session is `running`/`awaiting_confirmation` (or `running:true` from `GET /sessions/:id`) the page opens `GET /sessions/:id/events?after=<lastSeq>&token=<jwt>` and reconnects with the last seen seq.

## Verification

`bun run --filter @sf-claws/admin-ui build` from the repo root. Headless render checks (playwright-core, Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, `--no-sandbox`) against `bunx --bun vite preview` cover the login/register screens, a fake token with the API unreachable (offline state with retry), the full shell on every route with only `/health` + `/auth/me` mocked (every page degrades to inline error states, no console errors besides failed fetches), role gating for `user`, and a mocked session with every event type rendered. Test scripts live outside the package.
