# Tenancy and isolation

SF Claws is normally run by one agency for several clients at once. Each client has their own
Salesforce orgs, their own GitHub repository, their own sessions and their own documentation. This
document says exactly what keeps those apart, what does not, and what to do when a client needs a
stronger guarantee than the default gives.

Read it before deciding how to deploy. The right answer is different for an in-house team running
one org than for an SI agency running twenty clients under a contract.

## Who sees which client

Access to a client is a membership, not a role. The `client_members` table says which users may
see a client; every HTTP route addressed by an org, a client, a session or something owned by one of
them (`/orgs/:orgId/*`, `/clients/:clientId/*`, `/sessions/:id/*`, `/docs/:docId`, projects and
tasks, client-scoped skills, `GET /admin/policy?clientId=`) checks it first, through
`requireClientAccess` / `requireOrgAccess` in `packages/server/src/http/access.ts`. Listings
(`GET /orgs`, `GET /clients`, `GET /sessions`, `GET /skills`, `GET /admin/sessions`,
`GET /admin/budget`) are filtered to the caller's clients. `POST /sessions` refuses an org the
caller cannot see, and `GET /orgs/resolve` (the extension asking "which org is this tab?") answers
"not found" for an org that belongs to someone else's client.

The rule in one line: **a super admin belongs to every client; everyone else, platform admins
included, belongs only to the clients they were added to.** A platform `admin` who is not a member
of a client cannot see its orgs, sessions, GitHub repository, policy override or spend. A user
removed from a client loses access to their own past sessions on it. Membership has two levels:
`member` sees the client and their own sessions; `admin` (a client admin) also sees every session of
that client, the way a platform admin does within their clients.

Only a super admin changes membership (`PUT`/`DELETE /clients/:clientId/members/:userId`, the
**Members** tab on the client page in the admin console). An admin who creates a client is made a
client admin of it, so they can see what they just made. The **Users** page shows each user's
clients so an operator can tell at a glance who sees what.

This is a runtime check, and it is also a build-time one: `test/tenant-isolation.test.ts` walks the
real Fastify route table and fails if any route with an org, client, session, doc, project, task or
skill parameter answers anything but 403 or 404 to a non-member admin. A route that must be
reachable across clients (user administration, platform model registry) is listed there with a
written reason, and a second test fails when an allowlisted route stops existing.

## The three boundaries

Isolation here is enforced in three different places, and they fail differently.

### 1. The tool surface (structural)

This is the strongest boundary and the one that matters most for an AI system.

Every tool in `packages/server/src/agents/tools.ts` reads its target from the `ToolContext` that
`SessionRuntime.toolContext()` built when the session started. **No tool takes an org id or a client
id from the model.** A tool call can say `SELECT ... FROM Account`; it cannot say which org to run
it against.

The consequence is worth stating plainly: prompt injection — a malicious record in an org, a hostile
file in a linked repository, a crafted user message — cannot make an agent read or write another
tenant's org. There is no argument for it to poison. The worst it can achieve is making the agent
say something wrong, which is a bug, not a breach.

### 2. Who may address a tenant at all (membership)

The boundaries below stop a session reaching the wrong org. This one decides which tenants a person
can address in the first place.

`superadmin` and `admin` administer the platform and see every client, unconditionally. A `user`
sees only the clients an admin has listed them against in `client_members`. Membership is the whole
rule: there are no per-client roles and no wildcard row. `requireClientAccess` / `requireOrgAccess`
in `src/http/context.ts` are the single evaluation point, applied where each route file already
resolves its subject, and list endpoints filter by `visibleClientIds`. An admin assigns clients from
the user edit dialog in the admin console.

Until this existed, every approved user could list every client's orgs and open every session. If
you are upgrading a deployment, assign memberships before you hand the extension to a consultant:
a user with no memberships can sign in and has access to nothing.

### 3. The data layer (enforced by a test)

Every query against a tenant-owned table carries a scoping predicate. This is checked by
`packages/server/test/tenant-isolation.test.ts`, which parses the SQL in the repository layer and
fails the build on an unscoped read. Genuine exceptions — admin inventories, the extension's
tab-resolution lookup — live in an allowlist that must carry a written reason, and a second test
fails if an allowlist entry stops matching the code that justified it.

This is a build-time guarantee rather than a runtime one, on the reasoning that the failure mode
being defended against is a future coding mistake, and a mistake caught in CI is cheaper than one
caught by a rate limiter in production.

### 4. Secrets at rest (envelope encryption)

Each tenant has its own AES-256-GCM data key. Only that key is wrapped by the server `MASTER_KEY`.
Salesforce refresh and access tokens and GitHub tokens are encrypted under the owning client's key
(`SecretBox.encryptFor(clientId, ...)`), so:

- a leaked ciphertext exposes one tenant, not all of them;
- a compromised tenant key exposes one tenant;
- a tenant's key can be rotated without touching any other tenant's rows.

Server-wide secrets that do not belong to a tenant — AI provider keys, knowledge source tokens — are
encrypted with the master key directly.

Ciphertexts carry their format: `v1.…` is master-key encrypted, `v2.<keyId>.…` is tenant encrypted.
Both are readable, so upgrading an existing deployment does not require a migration pass.

## What the default deployment does not isolate

Be honest with yourself about these before promising a client anything.

**One process, all sessions.** Every session's agent loop runs in the same Node process. A crash,
an out-of-memory, or a runaway loop degrades or kills every other running session. Session state is
persisted continuously (events, messages, todos, notes, workspace, confirmations) and
`recoverOnBoot` marks interrupted sessions resumable, so nothing is *lost* — but everyone is
interrupted together.

**One database file.** All tenants share one SQLite database. The scoping guard above is what keeps
their rows apart; there is no physical separation.

**One AI provider key by default.** With a shared platform key, one client's parallel sub-agents
compete with another's for the same rate limit. Per-user keys (`/me/providers`) and per-client
budgets remove this where it matters.

**The super admin sees everything, and so does anyone you make a member.** A super admin can read
every client's configuration, policy and sessions; a member sees everything about the clients they
belong to. Membership is a role boundary enforced in the HTTP layer, not a security boundary in the
data layer: the rows all sit in one database, and a bug in a route would expose them. If your threat
model includes a malicious or compromised super admin, or requires that one client's data be
physically unreachable from another's, you need separate deployments.

Until this release every approved user could read every client (`GET /orgs` returned all orgs, org
queries and metadata reads were open to any active user), and an earlier version of this document
wrongly said only the super admin could. See the changelog at the end.

## Choosing a deployment shape

### Shared multi-tenant (default)

One instance, one database, many clients. Appropriate when the clients are all customers of the same
agency, under the same contract and the same operator, which is the common case.

```bash
docker compose up -d
```

What you should still do:

- set `maxSessionCostUsd` and `maxClientMonthlyCostUsd` in policy;
- keep `impactAllowList` narrow, and `allowDataModification` off unless needed;
- back up `DATA_DIR` — it holds the database and therefore every tenant's encrypted secrets.

### Dedicated tenancy (one instance per client)

One instance, one database, one client. Appropriate when a client contractually requires isolated
infrastructure, when a regulator requires it, or when one client's load must not be able to affect
another's.

This is a supported configuration, not an improvisation. Nothing in the code assumes more than one
client exists: run N instances, each with its own `DATA_DIR`, its own `MASTER_KEY`, and its own port,
and route to them however you already route.

```bash
# One directory per isolated client, sharing nothing.
DATA_DIR=/srv/sf-claws/acme     PORT=8801 MASTER_KEY=<acme key>     PUBLIC_URL=https://acme.example.com   bun run start
DATA_DIR=/srv/sf-claws/globex   PORT=8802 MASTER_KEY=<globex key>   PUBLIC_URL=https://globex.example.com bun run start
```

With `docker compose`, give each client its own service, its own named volume for `DATA_DIR`, and its
own `MASTER_KEY` from your secret store. Do not share a volume between them: two processes writing
one SQLite file is a corruption bug waiting to happen, and it would also defeat the point.

What you gain: a crash, a memory blowup, a runaway loop, a database compromise or a leaked master key
is contained to one client. What you pay: N deployments to upgrade, monitor and back up, and users
who work across clients need an account per instance.

### A note on per-session containers

Running a container per *session* is not supported, and would not be the right grain if it were.
Sessions are short bursts of work driven by HTTP turns, so a container per session would pay
start-up latency on every message. The state that can actually grow without bound — a repository
snapshot, a large query result — is already capped in code (`packages/server/src/knowledge/repo-store.ts`
and `packages/server/src/agents/budget.ts`). If per-session isolation ever becomes necessary, the
right shape is a worker per session inside the process, not a container per session.

## Operational checklist

- [ ] `MASTER_KEY` is 32 random bytes, base64, stored in a secret manager and not in the repository.
- [ ] `DATA_DIR` is backed up, and the backup is encrypted.
- [ ] TLS terminates in front of the server; device pairing codes and JWTs travel over it.
- [ ] Spend ceilings are set for every client.
- [ ] Knowledge sources use a dedicated read-only token, never a client's GitHub token.
- [ ] The audit log is reviewed, or shipped somewhere that is.
- [ ] Every non-super-admin user is a member of exactly the clients they work on, and nobody else.
- [ ] `TRUST_PROXY` matches your topology: on behind a reverse proxy, off otherwise.
- [ ] You know which deployment shape each client is on, and have told them.

## Changelog

- **2026-09, client membership.** Added `client_members` and route-level scoping. Before this,
  any approved user could list and query every client's orgs, read every client's GitHub tree and
  skills, and create a session against any org; this document claimed otherwise. Upgrading seeds
  no memberships: after the migration, users other than super admins see no clients until a super
  admin adds them on each client's Members tab (`docs/DEPLOYMENT.md`, "First run after upgrading").
  Same release: the rate limiter and the `?token=` exception match the routed path rather than the
  raw URL, access logs redact credential query parameters, and `X-Forwarded-For` is honoured only
  with `TRUST_PROXY=true`.
