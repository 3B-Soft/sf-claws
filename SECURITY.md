# Security policy

SF Claws holds Salesforce OAuth refresh tokens, GitHub tokens and AI provider keys, and it deploys
metadata to production Salesforce orgs. It is designed to be self-hosted, often by an agency running
it for several clients at once. Security reports matter here more than they would for a library.

Clients configured for browser-session authentication additionally send the active Salesforce `sid` bearer credential from the Chrome extension to the control plane. It is validated against the
configured My Domain and Salesforce org id and held in process memory only. It is intentionally not
written to SQLite, logs, audit details, or model context.

## Reporting a vulnerability

Please report privately, not as a public issue:

- Use GitHub's **Report a vulnerability** button under the repository's Security tab, or
- email **security@3b4sf.com**.

Include what you did, what happened, and what you think the impact is. A proof of concept helps but
is not required. We will acknowledge within three working days and keep you updated while we work on
a fix. If you would like credit in the release notes, say so.

Please do not test against an org or a deployment you do not own.

## What we consider a vulnerability

Anything that breaks one of the guarantees below. In particular:

- **Cross-tenant access.** One client's session reading, writing or influencing another client's
  org, secrets, sessions, documentation or usage data.
- **Secret disclosure.** Any path that returns key material — Salesforce tokens, GitHub tokens, AI
  provider keys — through the API, the UI, logs or an error message.
- **Bypassing the approval gate.** Causing an impactful command (deploy, anonymous Apex, record
  changes, test runs, commits) to execute without the allow-list check and the user confirmation
  that `runtime.gate()` performs.
- **Bypassing policy.** Writing a forbidden metadata type or a protected component, deploying
  without a clean validation, or evading a spend ceiling.
- **Privilege escalation.** A `user` acting as `admin`, or an `admin` acting as `superadmin`.
- **Prompt injection with real consequences.** Content in an org, a repository or a document that
  causes an agent to take an action outside the session's scope. Note that a tool call cannot select
  which org it targets — the org is bound to the session at creation — so an injection that merely
  changes what the model _says_ is a bug, while one that reaches another tenant is a vulnerability.

## What the current design does and does not guarantee

Being explicit, because self-hosters need to make their own risk decision. See `docs/TENANCY.md`
for the full picture.

**Guaranteed by construction:**

- Tool calls are bound to one org and one client at session creation. No tool takes an org id from
  the model, so no model output — however adversarial — can redirect a call to another tenant.
- Every org-, client- and session-addressed HTTP route checks client membership before anything
  else. A super admin belongs to every client; everyone else, platform admins included, sees only
  the clients they were added to. A build-time test walks the route table and fails on any such
  route a non-member can reach.
- Agents have no shell, no filesystem access and no code interpreter. Nothing an agent authors is
  executed on the server; metadata is sent to Salesforce, which does its own validation.
- Every impactful command passes an allow list and an explicit user confirmation showing the exact
  command and the agent's plain-language reason.
- Secrets are AES-256-GCM encrypted at rest, with per-tenant data keys wrapped by the server master
  key, so one compromised ciphertext or data key exposes one tenant.
- A build-time guard fails CI on any unscoped read of a tenant-owned table.

**Not guaranteed in the default deployment:**

- **Process isolation between sessions.** All sessions share one Node process. A crash or memory
  exhaustion in one session affects the others. Run separate instances per client where that is
  unacceptable (`docs/TENANCY.md`).
- **Provider-side isolation.** With a shared platform API key, one client's usage competes with
  another's rate limit. Per-user and per-client keys are supported and remove this.
- **Protection against a malicious super admin or member.** A super admin can read every client's
  configuration and change policy; a member sees everything about their clients. Membership is a
  role boundary enforced in the HTTP layer, not a physical one in the database.
- **Recorder secrecy from the page itself.** The extension's page recorder keeps its buffers in a
  closure, answers only its own content script (same window, same origin, per-injection nonce) and
  scrubs credential-looking query parameters before recording. Script running in the page's own
  world can still observe that exchange; what it would see is the page's own console and network
  activity, which it already has.
- **Complete protection against regex denial of service.** Search tools take a regular expression
  from the model, and JavaScript's engine backtracks. We reject patterns that nest one unbounded
  repetition inside another — the shape that goes exponential — cap pattern length, cap the input
  each match runs against, and bound the whole search with a deadline. That covers the classic
  attacks, but a structural check is not a proof: the complete fix is a linear-time engine such as
  RE2, which we have not adopted because a native dependency makes self-hosting harder. If you find
  a pattern that passes the guard and still hangs, that is a vulnerability worth reporting.

## Supported versions

Pre-1.0: fixes land on `main`. Once tagged releases exist, the latest minor version is supported.

## Operational advice for self-hosters

- Set a strong `MASTER_KEY` (32 random bytes, base64) and keep it out of the repository. Losing it
  means every stored secret is unrecoverable; leaking it plus a database dump means every secret is
  compromised.
- Put the server behind TLS. Device pairing codes and JWTs travel over it. Set `TRUST_PROXY=true`
  only when a reverse proxy in front of the server overwrites `X-Forwarded-For`; otherwise any
  caller can forge the address in the audit log and the rate-limit key.
- Make every non-super-admin user a member of exactly the clients they work on (client page,
  Members tab). Membership, not role, decides what a user can see.
- Set `maxSessionCostUsd` and `maxClientMonthlyCostUsd`. An unbounded agent loop is a financial
  incident as much as a technical one.
- Keep `impactAllowList` as narrow as the work allows, and leave `allowDataModification` off unless
  a client genuinely needs record changes.
- Review the audit log (`/admin/audit`) — every login, approval, deploy, commit and configuration
  change is recorded there.
