---
name: Salesforce design discipline
kind: quality
scope: global
roles: []
---

# Salesforce design discipline

Least resistance says how small a change should be. This says how to choose the mechanism so the
small change actually works for the person who triggers it. Both apply; when in doubt, the
execution-context rule below wins over "simplest".

## Three questions before any mechanism

1. **Who triggers it, and in what context?** An admin in Setup, an internal user saving a record,
   an authenticated Experience Cloud user, a guest user, a scheduled job, an integration user, a
   platform event. The answer decides what the change is allowed to do, and it is not the same
   person as the one asking.
2. **What can that context not do?** Object and field access, sharing, sending email, callouts,
   owning records, running Apex it has not been granted, objects its license excludes. Data access
   and actions can run as different users in the same flow: see "Salesforce flows".
3. **What is the smallest mechanism that works in that context?** Configuration before automation,
   Flow before Apex, extend before duplicate; but a formula the guest cannot read, or a flow whose
   email action runs as the guest, is not "simpler", it is broken.

## Checking access

Do not assert what a user can do; check it. Use the User Access Summary on the user or permission
set, `UserRecordAccess` for record-level access, `ObjectPermissions` / `FieldPermissions` queries
for object and field access, and the user's license for what it can never have. Say in the plan
which of these you used.

## Context gotchas

1. Before-save flows can read related records but only write to the triggering record: no email,
   no related-record DML, no actions.
2. Record-triggered and schedule-triggered flows run in system context without sharing. Screen
   flows run as the user in front of them, guest included, unless `runInMode` says otherwise.
3. Guest users cannot edit or delete records or own them, and get Read only through guest sharing
   rules. A guest "updating a Contact" is always a flow or Apex doing it. (Confirm current object
   permission limits in the org before relying on them.)
4. Email in a guest transaction fails unless sent from a verified org-wide address. Send it from a
   platform-event-triggered flow instead, and name a verified org-wide address as sender there too:
   the Automated Process user cannot send as itself.
5. Authenticated Experience Cloud users see records through external org-wide defaults, sharing
   sets and sharing rules, and their license can exclude whole objects. Internal-user testing proves
   nothing about them.
6. Integration users typically have only what their permission sets grant. Record-triggered flows
   still fire on their saves; actions in those flows run as the integration user.
7. Sandboxes default to "System email only": password resets still send, but workflow, flow and
   user email do not. Check the Deliverability setting before concluding an email "doesn't work".
8. Deploy flows as Draft to production unless the user asked for activation, then activate as a
   separate, confirmed step. Whether `Active` goes live on deploy depends on the org's settings; do
   not rely on either behaviour.
9. New fields are invisible until field-level security grants them. Grant through a permission set,
   never a profile, and add the field to the layout or record page the user actually opens.
10. Managed-package components (namespace\_\_X) cannot be edited, only extended: layouts, permission
    sets, your own fields and flows on their objects.
11. Extend the existing record-triggered flow on an object and event rather than adding a sibling.
    If a separate flow is justified, set trigger order explicitly.
12. Apex runs in system mode: `with sharing` enforces sharing only, never object or field
    permissions. Enforce them with `WITH USER_MODE`, `AccessLevel.USER_MODE` or
    `Security.stripInaccessible`. A class with no sharing keyword inherits its caller's;
    `@AuraEnabled` controllers default to `with sharing`.

## What a plan must say

- Who triggers the change and the context it runs in (question 1), in one line.
- The mechanism chosen. When the choice is non-obvious or the context is restricted (guest,
  external, integration, async), add "Alternatives considered": two or three, one line each on why
  they lose in that context.
- What the triggering user can and cannot do that the design depends on, and how you checked.
- Which existing component you extend instead of duplicating.
- What deploys inactive or hidden (Draft flows, fields without FLS, unassigned permission sets,
  components not on a page), and what turns it on.
- How you will verify it as the triggering user.

## Which skill to load

Load every skill whose area the request touches before planning; do not guess from memory.

- Flows, entry conditions, async and scheduled paths, flow errors: "Salesforce flows".
- Profiles, permission sets, sharing, Experience Cloud guest and external users: "Salesforce security and guest users".
- Apex, triggers, tests, LWC, order of execution: "Salesforce Apex and LWC".
- Fields, relationships, record types, formulas, deploy mechanics: "Salesforce data model and deployment".
- Platform events, callouts, named credentials, email sending: "Salesforce events, integration and email".
- Sandboxes, release process, naming, conventions for a consultancy: "Salesforce admin operating model".
- "Why can't they see / why didn't it fire / why no email / why this error / where did this value come from": "Playbook — why is this happening", plus the skill for the area the answer lives in.
