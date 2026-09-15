# Deployment

## 1. Salesforce Connected App (once, in any org you control)
1. Setup → App Manager → New Connected App. Enable OAuth settings.
2. Callback URL: `https://<your-server>/api/v1/oauth/salesforce/callback`
3. Scopes: `api`, `refresh_token, offline_access`, `web`, `openid`.
4. Enable PKCE ("Require Proof Key for Code Exchange"); disable "Require secret for Web Server Flow" if you prefer PKCE-only (then leave `SF_CLIENT_SECRET` empty).
5. Copy Consumer Key → `SF_CLIENT_ID`, Consumer Secret → `SF_CLIENT_SECRET`.
Each client org is authorised by an admin clicking "Connect to Salesforce" in the admin console; the refresh token is stored encrypted. For sandboxes set the org's login URL to `https://test.salesforce.com` (or the MyDomain login URL).

## 2. GitHub
Per client, create a fine-grained personal access token (or a GitHub App installation token) with `Contents: read/write` and `Pull requests: read/write` on the client's SFDX repository, and enter it in the client's GitHub tab. The repository must already contain the SFDX project (default `force-app/main/default`).

## 3. AI providers
In the admin console (super admin): AI → Providers → set a key for any of Anthropic, OpenAI, DeepSeek or DeepInfra, then enable models and bind roles. DeepSeek and DeepInfra speak the OpenAI protocol and default to their own endpoints, so a key is all they need; DeepInfra model ids are namespaced by publisher (`deepseek-ai/DeepSeek-V3`). Defaults: orchestrator/builders on `claude-opus-5`, analyst/reviewer/doc_writer on `claude-sonnet-5`, summarizer on `claude-haiku-4-5`. Verify prices in the models table.

## 4. Server
```bash
npm ci
npm run build
cd packages/server
cp .env.example .env    # set PUBLIC_URL, MASTER_KEY, JWT_SECRET, SF_CLIENT_ID/SECRET, CORS_ORIGINS
NODE_ENV=production node dist/index.js
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
      SF_CLIENT_ID: "<consumer key>"
      SF_CLIENT_SECRET: "<consumer secret>"
    volumes:
      - sf-claws-data:/data
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ['80:80', '443:443']
    command: caddy reverse-proxy --from srv123456.hstgr.cloud --to sf-claws:8787
    volumes:
      - caddy-data:/data
volumes:
  sf-claws-data:
  caddy-data:
```
To upgrade, run `git pull && docker build -t sf-claws:latest .` in the checkout, then recreate the stack from the UI. Back up the `sf-claws-data` volume.

## 5. Chrome extension
Build: `npm run build -w @sf-claws/extension`. Distribute `packages/extension/release/sf-claws.zip` via the Chrome Web Store (private/unlisted) or enterprise policy (`ExtensionInstallForcelist`), or load `packages/extension/dist` unpacked for development. On first run each admin enters the server URL, requests permission for that origin, and pairs the device: the panel shows a code, the admin console approves it (the user must already be approved by the super admin).

## 6. Environment reference
See `packages/server/.env.example`. `CORS_ORIGINS` must include the admin UI origin when it is served separately; Chrome extension origins are always allowed. `TRUST_PROXY` (default `false`) controls whether `X-Forwarded-*` headers are honoured; see section 4.

Access logs never contain bearer tokens: the `Authorization` header is redacted, and so are the `token`, `code` and `state` query parameters (the SSE stream authenticates with `?token=` because `EventSource` cannot set headers).
