# Publishing the Chrome extension

Everything the Chrome Web Store asks for, in the order it asks for it. The build is reproducible,
so the only manual steps are the listing text and the upload itself.

## 1. Build the upload

```
npm run build -w @sf-claws/shared
npm run build:store -w @sf-claws/extension
```

`build:store` differs from `build` in two ways, both in `scripts/postbuild.mjs`:

- it strips `http://localhost/*` from `optional_host_permissions`, because that origin is only ever
  useful to someone running the control plane on their own machine from an unpacked build, and the
  store shows every optional origin on the install prompt;
- it writes `release/sf-claws-store-<version>.zip` instead of `release/sf-claws.zip`, so a store
  upload can never be confused with a development build.

`manifest.json` sits at the root of the zip, which is what the store expects.

## 2. Version

`packages/extension/package.json` is the single source. `src/manifest.json` must not declare a
`version` — postbuild throws if it does, because a second copy silently drifts from the one that
ships.

The store requires a strictly increasing version on **every** upload and a version number can never
be reused, even for a rejected submission. Bump `packages/extension/package.json` before each
upload.

## 3. Listing copy

**Name:** `SF Claws`

Not "SF Claws for Salesforce". Google's branding policy tolerates a "for X" descriptor, but names
that read as first-party are a common rejection, and Salesforce's own trademark guidelines are
stricter than Google's. The description carries the "for Salesforce admins" framing instead.

**Short description** (132 char limit; this is the manifest `description`, 127 chars):

> Agentic Salesforce admin assistant: debug orgs, query records, build and deploy metadata, commit
> to GitHub — from a side panel.

**Category:** Developer Tools. **Language:** English.

**Detailed description:**

> SF Claws puts a Salesforce admin assistant in Chrome's side panel, next to the org you are already
> working in.
>
> Describe a change in plain language. The agent investigates the org, writes a plan you approve,
> stages the metadata, validates it against the org with a check-only deploy, and shows you the diff.
> Nothing is saved to your org until you confirm it, and destructive or data-changing commands need a
> separate approval that states what it will touch and why.
>
> - Chat that follows the tab you are on, so it already knows the object, record or setup page
> - A plan you approve before anything is built
> - Every staged change as a diff, validated before deploy
> - Deploy and commit to GitHub as separate, explicit steps
> - A visual SOQL builder and a metadata browser for flows, objects and layouts
> - Apex debug logs, org limits and browser console errors in one place
>
> SF Claws requires an SF Claws control plane, which your organisation self-hosts. The extension is
> a client for that server: it holds no API keys and talks to no service your administrator has not
> configured. The server is open source (Apache-2.0).

## 4. Single purpose

> A side panel that lets a Salesforce administrator work on their org through an AI agent running on
> their organisation's self-hosted SF Claws server.

## 5. Permission justifications

One box each in the dashboard. These describe what the code actually does.

| Permission | Justification |
|---|---|
| `sidePanel` | The entire user interface is a Chrome side panel opened from the toolbar icon. |
| `storage` | Stores the control-plane URL and the visual/pro display preference in `storage.sync`, and the sign-in token in `storage.local`. No page content is stored. |
| `tabs` | The panel shows the Salesforce org belonging to the tab the user is on. We read the active tab's URL to resolve which registered org it is, and to badge Salesforce tabs. |
| `activeTab` | Reads the current Salesforce URL so the assistant knows which object, record or setup page the user is looking at when they ask a question. |
| `scripting` | Injects a small recorder into the Salesforce tab, on demand, so the user can ask the assistant to look at the JavaScript errors and failed network calls their page produced. It is injected only into the tab a session is open on. |
| `notifications` | When an agent needs the user to approve an action and the side panel is not visible, a notification tells them a decision is waiting. User-toggleable on the options page. |
| Host permissions (`*.lightning.force.com`, `*.my.salesforce.com`, `*.my.salesforce-setup.com`, `*.vf.force.com`, `*.visualforce.com`) | The content script reads page context (object, record id, setup page) on Salesforce org domains only. Public Experience Cloud domains are deliberately excluded. |
| `optional_host_permissions` (`https://*/*`) | The extension talks to an SF Claws control plane that each organisation self-hosts at its own domain, which cannot be known at build time. The user types that URL and Chrome then prompts for that one origin — the extension never requests the broad pattern itself. |

That last row is the one a reviewer is most likely to question. The relevant code is
`packages/extension/src/lib/bridge.js`, which only ever calls
`chrome.permissions.request({ origins: [origin] })` for the single host the user entered.

**The page recorder** is worth pre-empting, because it is the part that looks most invasive:

> Console output and failed network calls are recorded in the page's own world so the assistant can
> be asked to look at them. Buffers live in a closure, not on `window`. Replies are only sent to
> same-window, same-origin requests carrying a per-injection nonce. URLs are scrubbed of
> credential-shaped query parameters (`sid`, `token`, `session`, `secret`, `password`, `key`, …)
> before being stored. A navigation disarms the recorder until the panel arms it again.

## 6. Privacy

A privacy policy URL is **mandatory** for this listing — the extension handles authentication
information and work-related content — and a URL that 404s is an instant rejection. Publish one
before submitting.

Data-use disclosures, answered honestly:

- Authentication information: **yes** (a sign-in token for the customer's own server).
- Website content: **yes** (Salesforce page context, and console/network output when the user asks).
- Personally identifiable information, health, financial, location, web history, user activity: **no**.
- Sold to third parties: **no**. Used or transferred for purposes unrelated to the single purpose:
  **no**. Used to determine creditworthiness: **no**.

Nothing is sent to 3B: the extension talks only to the control plane the customer self-hosts.

## 7. Assets

In `docs/store/`, regenerated by `tools/store-assets.mjs` (see `docs/store/README.md`):

| File | Size | Store field |
|---|---|---|
| `screenshot-1-panel.png` … `screenshot-5-policy.png` | 1280x800 | Screenshots (up to 5) |
| `promo-small-440x280.png` | 440x280 | Small promo tile |
| `promo-marquee-1400x560.png` | 1400x560 | Marquee tile (optional, for featuring) |
| `store-icon-128.png` | 128x128 | Store icon |

The mark is the 3B logo in brand green `#00ca72`, rasterised from `packages/extension/src/icons/logo.svg`.
The promo tiles are 24-bit RGB with no alpha, which is what those two fields require; the store icon
keeps its transparency, which that field allows. White type on the tiles was measured against the
gradient actually behind it and clears WCAG AA.

The product shots inside them are real renders of the built UI against `tools/demo-server.mjs`, not
mockups. Store policy requires screenshots to represent actual functionality, so regenerate them
rather than editing them when the UI changes.

## 8. Visibility

Pick this before submitting, because it decides how hard review is.

- **Unlisted** (recommended): installable by anyone with the link, not searchable. This is what
  `docs/DEPLOYMENT.md` assumes.
- **Private**: visible only to members of a Google Workspace domain you own.
- **Public**: searchable. Only worth it with a demo server a reviewer can actually sign in to.

A reviewer who installs the extension sees a "connect to your control plane" screen and can get no
further without a server. For a public listing you must supply a reachable demo server URL and test
credentials in the **Account** field, or review will stall.

For managed rollout, `ExtensionInstallForcelist` works against an unlisted item by ID.

## 9. Submission checklist

- [ ] `npm run lint && npm run typecheck && npm test` clean
- [ ] Version bumped in `packages/extension/package.json`
- [ ] `npm run build:store -w @sf-claws/extension`, upload `release/sf-claws-store-<version>.zip`
- [ ] Name, short and detailed description from section 3
- [ ] Single purpose from section 4
- [ ] All eight permission justifications from section 5
- [ ] Privacy policy URL live, disclosures from section 6
- [ ] Screenshots and tiles from `docs/store/`
- [ ] Visibility set (section 8); test credentials filled in if public
- [ ] Submit

## Notes

- The store assigns the extension ID on first publish. No server change is needed for it:
  `packages/server/src/http/app.ts` accepts any `chrome-extension://` origin for CORS. If you later
  want to narrow that to the published ID, it is stable from the first publish onward.
- Remote code: answer **no**. The extension loads no JavaScript from any server; it fetches data
  only. The manifest CSP is `script-src 'self'` and there are no `web_accessible_resources`.
- The bundle is minified, which is allowed. Obfuscation is not, and nothing here obfuscates.
- The toolbar icon is the full 3B mark at every size. It is tight at 16px, where the logo's own
  frame takes most of the canvas; if that bothers you, point the 16 and 32 entries at a variant
  without the outer frame rather than shrinking the whole mark further.
