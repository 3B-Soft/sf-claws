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
   a guest user on an Experience site, a scheduled job, an integration user, a platform event. The
   answer decides what the change is allowed to do, and it is not the same person as the one asking.
2. **What can that context not do?** Object and field access, sharing, sending email, callouts,
   owning records, running Apex it has not been granted. The async path of a record-triggered flow
   runs in system context for data, but actions (email, callouts, invocable Apex) still run as the
   triggering user. A guest user cannot send email unless it goes from a verified org-wide address.
3. **What is the smallest mechanism that works in that context?** Configuration before automation,
   Flow before Apex, extend before duplicate; but a formula that the guest cannot read, or a flow
   whose email action runs as the guest, is not "simpler", it is broken.

## Ten gotchas

1. Before-save flows update only the triggering record: no email, no related records, no actions.
2. Record-triggered and scheduled flows run in system context without sharing. Screen flows run as
   the user in front of them, guest included, unless the flow is set to system context.
3. Guest users have no Edit or Delete on standard objects, cannot own records, and only get Read
   through guest sharing rules. A guest "updating a Contact" is always a flow or Apex doing it.
4. Email from a guest user is dropped unless sent from a verified org-wide address. Run the email
   from a platform-event-triggered flow (Automated Process user) instead of the guest transaction.
5. Sandboxes default to "System email only" deliverability: nothing you test there sends anything.
6. A deployed Flow with status Active goes live on deploy. Deploy as Draft to a production org
   unless the user asked for activation, then activate as a separate, confirmed step.
7. New fields are invisible until field-level security grants them; grant through a permission
   set, never a profile, and add the field to the layout or record page the user actually opens.
8. Managed-package components (namespace__X) cannot be edited, only extended: layouts, permission
   sets, your own fields and flows on their objects.
9. A second record-triggered flow on the same object and event is an ordering bug waiting to
   happen; add a branch to the existing one.
10. Apex runs in system mode: `with sharing` enforces sharing only, never object or field
    permissions. A user with no access still gets the data unless the code checks.

## What a plan must say

- Who triggers the change and the context it runs in (question 1), in one line.
- The mechanism chosen, and the two or three alternatives considered with one line each on why
  they lose in that context ("Alternatives considered").
- What the triggering user can and cannot do that the design depends on, and how you checked.
- Which existing component you extend instead of duplicating.
- What you deploy as Draft, and what turns it on.

## Which skill to load

Load one before planning in its area; do not guess from memory.

- Flows, entry conditions, async and scheduled paths, flow errors: "Salesforce flows".
- Profiles, permission sets, sharing, Experience Cloud guest users: "Salesforce security and guest users".
- Apex, triggers, tests, LWC, order of execution: "Salesforce Apex and LWC".
- Fields, relationships, record types, formulas, deploy mechanics: "Salesforce data model and deployment".
- Platform events, callouts, named credentials, email sending: "Salesforce events, integration and email".
- Sandboxes, release process, naming, conventions for a consultancy: "Salesforce admin operating model".
- "Why can't they see / why didn't it fire / why no email / why this error / where did this value come from": "Playbook — why is this happening".
