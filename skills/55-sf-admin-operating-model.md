---
name: Salesforce admin operating model
kind: knowledge
scope: global
roles: []
---
# Salesforce admin operating model

Load when deciding where and how a change is built and released: sandboxes, production safety, naming, documentation, consultancy habits in a client org.

## Environments

- Developer and Developer Pro sandboxes: metadata plus a little data; build here. Partial Copy:
  a sample of data by template; UAT here. Full: everything; performance and final acceptance.
- A refresh replaces the sandbox with production; anything not committed to source is lost. Commit
  to the client repository before asking for a refresh.
- Production and any org marked protected: every deploy is confirmed, Apex needs tests, flows go
  in as Draft unless activation was agreed, and nothing is "tried" there. If the only org available
  is production, say so in the plan and make the change smaller.

## Release habits

- Investigate first (`describe_sobject`, `list_metadata`, `read_metadata`, `flow_versions`), then
  plan, then build. The org's current state is the ground truth; the ticket is a hypothesis.
- One change, one validation, one confirmed deploy, one commit, one document. Bundling unrelated
  changes makes the rollback unreadable.
- Deploy windows: agree them for production; avoid the client's month-end, billing runs and
  campaign days. Ask when it is not in the standing instructions.
- After a deploy, verify in the org as the affected persona (login access or a test user), not only
  as the admin. Then tell the user what is live in their words.

## Naming conventions (defaults when the client has none)

- Fields: `Label_In_Title_Case__c`, a description on every field saying what fills it.
- Flows: `Object_Timing_Purpose` for record-triggered (`Contact_AfterSave_Notify_Owner`),
  `Screen_Purpose` for screen flows, `Event_Purpose` for event subscribers; a description with the
  ticket or session reference.
- Permission sets: by persona or capability (`Sales_Manager`, `Onboarding_Site_Guest`), never by
  project name.
- Apex: `ObjectTriggerHandler`, `PurposeService`, `PurposeTest`; one trigger per object named
  `ObjectTrigger`.
- Validation rules: `Object_Rule_Purpose`; the error message is the fix, not the condition.

## Standing instructions and memory

Client and org instructions are the client's CLAUDE.md: known packages, conventions, decisions
already made (a chosen mechanism, a rejected one), things to verify. Read them before planning;
when the org disagrees with them, trust the org and say so. Session documentation is memory for the
next session: record decisions and their reasons, constraints found, what was rejected and why.

## Communicating with the admin

They know the business process, not the XML. Lead with the finding or the action; name the
mechanism in business terms ("a flow that runs when the Contact is saved"); ask configuration
details (sender, template, record type) only after the design is chosen and only when the answer
changes what gets built. Never ask what a describe or a query would tell you.

## Housekeeping that prevents the next incident

Setup Audit Trail (`SELECT Action, Section, CreatedBy.Name, CreatedDate FROM SetupAuditTrail`) for
"who changed this"; `get_org_limits` before a data load; inactive flow versions and unused fields
noted for cleanup rather than deleted on impulse; trace flags removed when the investigation is
over; integration users with their own permission set and no UI login.
