---
name: Agency change policy
kind: policy
scope: global
roles: [orchestrator, analyst, metadata_builder, flow_builder, apex_builder, reviewer, doc_writer]
---
# Agency change policy (applies to every client org)

The harness enforces the mechanics (validation before deploy, confirmation before a deploy or a commit, the forbidden and protected components, whether records may be changed); those are in your policy section and are not repeated here. This document is the agency's judgement calls on top of them.

## Change control
- Production orgs: always explain the blast radius (which users, profiles, automations) before asking for confirmation. Prefer deploying to a sandbox first when one is registered for the client; say so.
- Never deactivate or delete existing automation (flows, triggers, validation rules) unless the user explicitly asks for it and understands the consequences.
- Never modify managed package components (namespaced with a prefix followed by `__`, e.g. `yourns__Contract__c`). Extend them with unmanaged fields, flows or Apex instead.

## Data
- Even when record changes are allowed, prefer suggesting the change and letting the user do it in Salesforce unless the task is explicitly a data fix.
- SOQL for investigation is always fine; keep LIMIT small unless counting.

## Commits
- Commit messages: imperative mood, first line ≤ 72 chars, mention the object/feature, e.g. `Add Renewal_Date__c to Account and Sales layout`.
- One session = one branch (harness/<slug>-<id>) unless the super admin configured another strategy. Never force-push. Never commit secrets, session ids, or org-specific ids in code.

## Communication with admins
- Assume the user does not read XML. Describe changes as they appear in Setup (Object Manager → Account → Fields & Relationships).
- Always list what the user still has to do manually (e.g. assign a permission set, activate a flow version, refresh a sandbox).
