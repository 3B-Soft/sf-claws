# Super admin guide

## Users
- Register → the first account is the super admin. Others land in **Users → Pending**; approve with a role (`user`, `admin`, `superadmin`). Disable revokes all sessions immediately.
- `admin` can manage clients/orgs, approve users and see sessions/usage for the clients they belong to; only `superadmin` manages AI providers, models, role bindings, skills, policies, GitHub tokens and client membership.
- The **Clients** column shows which clients each user can see. A super admin sees all of them; everyone else needs a membership per client (below). A user with no memberships can sign in but sees no orgs, so the extension tells them the tab is not a registered org.

## Clients and orgs
Create a client and choose its Salesforce authentication mode. External Client App mode is recommended; add each org's Consumer Key and optional Secret, then use "Connect to Salesforce". Browser-session mode requires each org's exact My Domain URL and an actively signed-in Salesforce tab; it cannot refresh an expired session or survive a server restart. Production is auto-protected. The extension resolves the org from the browser tab's My Domain host, so orgs must be registered before admins can use them.

### Members
Who may see a client is set on the client's **Members** tab (super admin only). Add each consultant who works on the client; the roles are `member` (sees the client, its orgs, GitHub, skills and policy, and their own sessions) and `admin` (client admin: also sees every session of that client). Removing a member closes their access immediately, including to their past sessions on that client; nothing is deleted, and adding them back restores it. Super admins belong to every client and cannot be added. An admin who creates a client becomes its client admin automatically.

After upgrading a deployment that predates membership, no one but super admins sees any client until you assign members. Do that first.

## AI models and role bindings
Register models with their prices; bind each agent role to a model with an effort level and iteration cap. Thinking effort is a super-admin setting per role, deliberately: end users do not tune inference, and a model choosing its own effort buys little for the cost of the mechanism. Temperature and Top P are optional per-model dials — blank means the provider default, which is what most deployments want, and both are unavailable on a thinking model because the providers reject them alongside extended reasoning. Cheap models for `analyst`, `reviewer`, `doc_writer`, `summarizer`; strongest model for `orchestrator`, `metadata_builder`, `flow_builder`, `apex_builder`. Use "Test connection" after entering a key.

## Skills (markdown)
Kinds: `policy` (rules), `quality` (standards), `knowledge` (how your managed packages work), `playbook` (recipes). Scope globally, per client or per org, and target roles. Skills are injected verbatim into the system prompts in a stable order (good for prompt caching). Edit the shipped "Managed package knowledge (template)" per package and enable it. Preview what a role sees: `GET /api/v1/skills/preview?orgId=&role=`.

## Policy (structured, enforced in code)
- `forbiddenMetadataTypes`, `protectedComponents` (globs like `yourns__*`) — writes are refused.
- `impactAllowList` — which impactful commands agents may attempt at all; `sessionAllowable` — which may be "always allowed" for a session after the first approval.
- `requireTestsForApex`, `minCodeCoverage`, `maxComponentsPerDeploy`, `allowDataModification`, `productionRequiresProMode`, `apiLimitWarnPercent`.
- Spend ceilings (`maxSessionCostUsd`, `maxTurnCostUsd`, `maxClientMonthlyCostUsd`, plus a documentation reserve) and `requirePlanApproval` (`always` / `nontrivial` / `never`). 0 means no ceiling. The plan gate is where a non-technical admin sees the change in business terms before anything is staged, so `never` is not recommended.
Global policy + per-client override.

## GitHub per client
Repository, default branch, source root, docs root, commit strategy (`direct`, `branch-per-session`, `branch-per-task`, `pull-request`), branch prefix, token (write-only). Compare and commit views are available to admins and in the extension.

## Observability
Sessions (all users) with transcript replay, workspace, deploys, docs, notes, usage per call; Usage summary by user/client/model/role; Audit log. Users mark sessions helpful/unhelpful — filter by `helpful=false` to find prompts/skills to improve.
