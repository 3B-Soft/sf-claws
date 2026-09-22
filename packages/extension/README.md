# SF Claws — Chrome extension

Manifest V3 side-panel extension for Salesforce admins. It follows the active Salesforce tab, resolves the registered org on the SF Claws control plane, and gives you a chat with the agent swarm, staged metadata changes with visual diffs, a SOQL/metadata explorer, notes/documentation and the GitHub view — all from the side panel.

## Install (unpacked)

1. From the repo root: `bun run --filter @sf-claws/extension build`
   - produces `packages/extension/dist/` (`manifest.json`, `sidepanel.html`, `options.html`, `background.js`, `content.js`, `assets/`, `icons/`)
   - and `packages/extension/release/sf-claws.zip` (same content, for distribution).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick `packages/extension/dist`.
3. Pin the extension. Clicking the toolbar icon opens the side panel (`openPanelOnActionClick`). Salesforce tabs get an `SF` badge.

To update after a rebuild, click the reload icon on the extension card.

## Configure the server

On first open the panel asks for the **server URL** of your SF Claws control plane (e.g. `https://harness.example.com`). It is stored in `chrome.storage.sync`. Chrome then prompts for permission to reach that host (`optional_host_permissions`), and the panel runs a health check (`GET /api/v1/health`). The URL can also be changed from the **Options** page (extension card → Details → Extension options, or the avatar menu → Options).

## Sign in (device pairing)

1. The panel requests a pairing code (`POST /auth/device/start`) and shows it.
2. Click **Open admin to approve** — the admin console opens at `<server>/pair?code=…`. Sign in there and approve the code.
3. The panel polls `GET /auth/device/poll?code=` every 2 s and signs in automatically. The token lives in `chrome.storage.local`.
4. Email & password is available as a fallback. Accounts still waiting for admin approval land on a "pending" screen.

Sign out from the avatar menu, or clear the login on the Options page.

## Using it

- **Org card** (header): client, org label, kind badge, connection status, protected flag, API-limits gauge (amber/rose when a limit crosses the policy threshold; warnings banner) and the page-context chip (record / list / Object Manager / Flow Builder / App Builder …). Org resolution is by host (`GET /orgs/resolve?host=`); unregistered hosts show "This tab isn't a registered org — ask your admin".
- **Chat**: sessions for this org, new session (captures the page context), streaming transcript (agents, tool steps with visual result renderers, validation panels, deploy/commit cards, docs, notes, policy blocks), live TODO plan pinned on top, approval cards (Why / What, Allow once / Allow for this session / Deny), session "always allow" chips (revocable), cancel, resume after an interruption, helpful/unhelpful feedback.
- **Changes**: workspace files grouped by metadata type, visual diff, Pro-mode XML editing, Validate → Deploy (only after a clean validation) → Commit (optional pull request), deploy history. Deploy and Commit show an in-panel confirmation first: the exact command and a plain-language summary of what it does; the button on that confirmation is what runs it. Validate and Deploy are long-running calls (the client waits up to 35 minutes, longer than the server's own deadline) and the outcome is taken from the `deploy.validation` / `deploy.result` events either way, so a slow deploy never shows as a false error.
- **Approvals waiting**: the extension icon shows the number of cards awaiting you; when the side panel is not in view a system notification is raised (toggle on the Options page, default on; `notifications` permission). The panel holds the event stream, so this only works while the panel is open somewhere.
- **Page recorder**: console output and failed network calls are recorded in the page's own world so an agent can ask for them (`browser.request` events). The recorder is not a manifest content script: the background injects it with `chrome.scripting.executeScript({ world: 'MAIN', allFrames: true })` into the one tab a session is open on (`armRecorder`), with a per-injection nonce; a navigation disarms it until the panel arms it again. Buffers live in a closure (nothing on `window`), replies go only to same-window, same-origin requests carrying the nonce, and credential-looking query parameters (`sid`, `token`, `session`, `secret`, `password`, `key`, ...) are scrubbed before a URL is stored. `allFrames` is kept because Lightning embeds Visualforce and the builders in iframes, and those are where the errors a user reports usually come from. Content scripts (and host permissions) match only `*.lightning.force.com`, `*.my.salesforce.com`, `*.my.salesforce-setup.com`, `*.vf.force.com` and `*.visualforce.com`; public Experience Cloud sites (`*.my.site.com`, legacy `*.force.com`) are deliberately excluded.
- **Explore**: visual SOQL builder (object, fields, filters, order, limit; editable SOQL in Pro) with record links and CSV copy-to-clipboard; metadata browser rendering Flows, objects, layouts and Lightning pages visually (raw XML / bundle files in Pro).
- **Notes**: agent scratchpad notes, session documentation and the org's documentation history (persistent memory).
- **GitHub**: repo, branch compare (session branch vs default) with per-file diffs, commits.
- **Visual / Pro** toggle in the avatar menu (also the default on the Options page). Pro exposes raw XML/JSON/SOQL and is sent as `uiMode` when creating sessions.

### Offline & recovery

Opening a session loads `GET /sessions/:id/snapshot`, stores it in IndexedDB (`src/lib/cache.js`, in-memory fallback) and renders from the cache instantly on later opens, then reconciles through the SSE stream (`?after=lastSeq`). If the server is unreachable the panel shows "Offline — last synced …" with the local copy, and resyncs automatically when a request succeeds again. The session list is cached per org as well.

## Development

```
bun run --filter @sf-claws/extension dev          # vite build --watch (reload the extension in Chrome after changes)
bun run --filter @sf-claws/extension build        # production build + postbuild (manifest, icons, zip)
bun run --filter @sf-claws/extension build:store  # the Chrome Web Store upload — see docs/PUBLISHING.md
```

- Stack: LWC (light DOM) + Tailwind v4 + Vite 7; components under `src/modules/x/`, plain modules under `src/lib/`.
- The side panel also runs as a plain web page (`dist/sidepanel.html` via `file://` or any static server): `chrome.*` is shimmed by `src/lib/storage.js` / `src/lib/bridge.js` (storage falls back to `localStorage`). Add `?sfUrl=https://acme.lightning.force.com/lightning/r/Account/001.../view` to simulate a Salesforce tab context.
- The version comes from `package.json` alone; `src/manifest.json` must not declare one (postbuild
  throws if it does, because a second copy silently drifts from the one that ships).
- `scripts/postbuild.mjs` bundles `src/content.js` as a classic IIFE (content scripts cannot be ES modules; `src/recorder.js` is bundled into `background.js` as a self-contained function passed to `executeScript`), copies `src/manifest.json` (version taken from `package.json`) and the 16/32/48/128 icons from `src/icons/`, and writes the release zip. The icons are the 3B logo, rasterised from `src/icons/logo.svg` by `tools/render-icons.mjs` — re-run it and commit the PNGs when the logo changes.
- CSP: `script-src 'self'` — no inline scripts; all JS is loaded from `assets/`.

## Server routes used

`/health`, `/auth/login|me|logout|device/start|device/poll`, `/orgs/resolve`, `/orgs/:id/{limits,query,describe/*,metadata/*,docs}`, `/sessions` (+ `/:id`, `snapshot`, `history`, `events` SSE, `messages`, `confirm`, `cancel`, `resume`, `feedback`, `workspace`, `workspace/file`, `deploys`, `validate`, `deploy`, `commit`, `docs`, `notes`, `todos`, `permissions`), `/clients/:id/github` (+ `branches`, `compare`, `commits`).
