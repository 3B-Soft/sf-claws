# Deployment

## 1. Salesforce authentication

Choose an authentication mode when creating a client. **External Client App** is recommended: it
supports refresh tokens, server restarts, and long-running work. **Browser session** is intended for
short, attended work: the Chrome extension reads the active org's `sid` cookie and sends it over TLS
to SF Claws, where it is kept in process memory only. It expires with the Salesforce session, is
lost on server restart, and gives the server the same Salesforce access as the signed-in user.
Only one Salesforce browser identity can supply an org at a time; disconnect the org before
switching identities so an existing agent run can never silently continue as another user.

Browser-session orgs must be registered with their exact My Domain URL. Users must grant the
extension cookie access and be signed into that org in Chrome. An allowed URL constrains where a
credential can be used; SF Claws also verifies the returned Salesforce org id before accepting it.

### External Client App (per org)

Each org authorizes through a Salesforce External Client App (or a legacy Connected App) whose Consumer Key and optional Secret are entered when the org is added in the admin console (client → Orgs → Add org). Create the app in the client's org, or reuse one app for several orgs you control:

1. Setup → App Manager → New Connected App. Enable OAuth settings.
2. Callback URL: `https://<your-server>/api/v1/oauth/salesforce/callback`
3. Scopes: `api`, `refresh_token, offline_access`, `web`, `openid`.
4. Enable PKCE ("Require Proof Key for Code Exchange"); disable "Require secret for Web Server Flow" if you prefer PKCE-only (then leave the Consumer Secret empty).
5. Copy the Consumer Key and Consumer Secret into the org's form.
   An admin then clicks "Connect to Salesforce"; the refresh token and consumer secret are stored encrypted with the client's key. Existing orgs can be given their own app with `PATCH /api/v1/orgs/:orgId` `{ "consumerKey": "…", "consumerSecret": "…" }` and then reconnected.

`SF_CLIENT_ID` / `SF_CLIENT_SECRET` in `.env` are optional: a fallback for orgs saved without a Consumer Key (including orgs connected before per-org apps existed). For sandboxes set the org's login URL to `https://test.salesforce.com` (or the MyDomain login URL).

## 2. GitHub

Set `GITHUB_TOKEN` in the server environment to share one GitHub account across configured client repositories and knowledge base sources. It needs `Contents: read/write` and `Pull requests: read/write` for client repositories, and read access to knowledge source repositories. For exceptions, enter a token in the client's GitHub tab or the knowledge source configuration; that token always overrides the environment token. Leave the token blank when creating a configuration to use the shared token; blank when editing preserves any existing custom token. Client repositories must already contain the SFDX project (default `force-app/main/default`).

## 3. AI providers

In the admin console (super admin): AI → Providers → set a key for any of Anthropic, OpenAI, Gemini, DeepSeek or DeepInfra, then enable models and bind roles. Gemini, DeepSeek and DeepInfra speak the OpenAI protocol and default to their own endpoints, so a key is all they need; DeepInfra model ids are namespaced by publisher (`deepseek-ai/DeepSeek-V3`). Defaults: orchestrator/builders on `claude-opus-5`, analyst/reviewer/doc_writer on `claude-sonnet-5`, summarizer on `claude-haiku-4-5`. Verify prices in the models table.

For environment-driven local setup, set any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, or `DEEPINFRA_API_KEY`. These are runtime fallbacks and are not copied into SQLite; a platform or per-user key entered in the UI takes precedence. An environment key makes the provider available, but you must still enable its model and bind the desired roles in the admin console.

## 4. Server

Requires Bun 1.3.12 or newer. CI and Docker pin 1.3.12. The server uses Bun's built-in SQLite driver;
the database path and migration history are unchanged.

```bash
bun install --frozen-lockfile
bun run build
cd packages/server
cp .env.example .env    # set PUBLIC_URL, MASTER_KEY, JWT_SECRET, CORS_ORIGINS
NODE_ENV=production bun dist/index.js
```

`ADMIN_UI_DIST=../admin-ui/dist` (default) serves the admin console from the same origin, including `/pair?code=` for extension pairing and the OAuth result page. Put the server behind TLS (nginx/Caddy/Cloud Run/etc.); SSE requires proxies to disable response buffering (`X-Accel-Buffering: no` is set).

When a reverse proxy terminates TLS, set `TRUST_PROXY=true` so the audit log and the rate limiter see the real client address from `X-Forwarded-For` instead of the proxy's. Leave it at the default `false` when clients reach the server directly: with no proxy overwriting the header, trusting it lets any caller forge the IP recorded in the audit log and split the rate limiter across invented addresses.

### First run after upgrading to client membership

Users other than the super admin no longer see every client. After upgrading, open each client in the admin console and add its consultants on the **Members** tab (or check the **Clients** column on the Users page); until then a `user` or `admin` account sees no clients, orgs or sessions. See `docs/TENANCY.md`.

Back up `DATA_DIR` (SQLite file `harness.sqlite` + WAL). Rotate `MASTER_KEY` only with a re-encryption migration (not provided); keep it in a secret manager.

### Docker

```bash
docker compose up -d --build     # uses docker-compose.yml, env from packages/server/.env
```

### Docker Manager (Hostinger, Portainer, …)

These UIs drive the host's own Docker, so build the image on the host once over SSH:

```bash
git clone https://github.com/3B-Soft/sf-claws.git && cd sf-claws
docker build -t sf-claws:latest .
```

Then deploy this compose file from the UI. It needs no `.env` file. Caddy terminates TLS and is the only service publishing ports, so the app is never reachable over plain HTTP. Replace `srv123456.hstgr.cloud` with your hostname (a Hostinger VPS hostname works without owning a domain) and fill in the secrets.

```yaml
services:
    sf-claws:
        image: sf-claws:latest
        restart: unless-stopped
        environment:
            PUBLIC_URL: https://srv123456.hstgr.cloud
            CORS_ORIGINS: https://srv123456.hstgr.cloud
            TRUST_PROXY: "true"
            MASTER_KEY: "<openssl rand -base64 32>"
            JWT_SECRET: "<openssl rand -base64 32>"
        volumes:
            - sf-claws-data:/data
    caddy:
        image: caddy:2
        restart: unless-stopped
        ports: ["80:80", "443:443"]
        command: caddy reverse-proxy --from srv123456.hstgr.cloud --to sf-claws:8787
        volumes:
            - caddy-data:/data
volumes:
    sf-claws-data:
    caddy-data:
```

To upgrade, run `git pull && docker build -t sf-claws:latest .` in the checkout, then recreate the stack from the UI. Back up the `sf-claws-data` volume.

## 5. Chrome extension

Build: `bun run --filter @sf-claws/extension build`. Distribute `packages/extension/release/sf-claws.zip` via the Chrome Web Store (private/unlisted) or enterprise policy (`ExtensionInstallForcelist`), or load `packages/extension/dist` unpacked for development. On first run each admin enters the server URL, requests permission for that origin, and pairs the device: the panel shows a code, the admin console approves it (the user must already be approved by the super admin).

## 6. Environment reference

See `packages/server/.env.example`. `CORS_ORIGINS` must include the admin UI origin when it is served separately; Chrome extension origins are always allowed. `TRUST_PROXY` (default `false`) controls whether `X-Forwarded-*` headers are honoured; see section 4.

Access logs never contain bearer tokens: the `Authorization` header is redacted, and so are the `token`, `code` and `state` query parameters (the SSE stream authenticates with `?token=` because `EventSource` cannot set headers).

## 7. Reflecting Server changes

If a change has been made in the repo, to reflect that change in the built VPS, follow:

1. Commit and push the changes

2. Rebuild the image on the VPS (over SSH, in the folder originally cloned):

```
cd sf-claws
git pull
docker build -t sf-claws:latest .
```

3. Back up your data, then restart the container. The new database change runs by itself when the server starts, but take a copy of the database first:
    ```
    docker run --rm -v sf-claws-data:/data -v "$PWD":/backup alpine tar czf /backup/sf-claws-data-$(date +%F).tgz -C /data .
    ```
    Then click Redeploy on the project in Hostinger's Docker Manager, or
    ```
    docker compose up -d --force-recreate
    ```
    Restarting alone isn't enough, because the container has to be recreated from the new image. Your data lives in the sf-claws-data volume, so it carries over.

## 8. Reflecting Chrome extension changes

1. Run commands to re-generate the extension package

```
bun run --filter @sf-claws/shared build
bun run --filter @sf-claws/extension build
```

- Loaded unpacked: open chrome://extensions, click reload on SF Claws, then close and reopen the side panel.

- Installed from the zip or the Web Store: hand out the new packages/extension/release/sf-claws.zip.

For the store, bump version in packages/extension/package.json first (it's still 0.0.1), or Chrome won't take the update.
