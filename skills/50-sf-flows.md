---
name: Salesforce flows
kind: knowledge
scope: global
roles: []
---
# Salesforce flows

Load when designing, changing or debugging a Flow: which flow type, entry conditions, async or scheduled paths, running context, faults.

## Which flow type

| Need | Type | Notes |
|---|---|---|
| Set fields on the record being saved | Record-triggered, before-save (fast field update) | No DML, no actions, no related records. Cheapest and bulk-safe. |
| Create/update related records, send email, call Apex after a save | Record-triggered, after-save | Runs in the same transaction; failures roll the save back unless on a fault path. |
| Do the work after the save commits, outside the transaction | After-save flow, **Run Asynchronously** path | Separate transaction, retried by the platform. System context for data; actions still run as the triggering user. |
| Do the work later (N days after a date) | After-save flow, **scheduled path** | Batched at the scheduled time. Check the date field is populated when the record enters. |
| Recurring job over a set of records | Schedule-triggered flow | Runs as Automated Process; one interview per record that matches. |
| User interaction | Screen flow | Runs as the user in front of it (guest included) unless set to system context. |
| React to a platform event | Platform-event-triggered flow | Runs as the Automated Process user (or the configured default workflow user), not as whoever published. |
| Called from Apex or another flow | Autolaunched | Inherits the caller's context. |

## Running context

- Record-triggered and schedule-triggered flows run in system context without sharing: object
  permissions, field-level security and sharing are ignored for Get/Create/Update.
- Screen flows and autolaunched flows default to user context. Guest-user screen flows on a site
  see only what the guest sharing rules grant; set "System Context Without Sharing" in the flow's
  version properties when the flow must read or write records the guest cannot.
- Actions are not data. Send Email, callouts and invocable Apex in a record-triggered flow, including
  its async path, execute as the triggering user. A guest user's Send Email is blocked unless the
  sender is a verified org-wide email address; the reliable route is to publish a platform event
  and send from the event-triggered flow.

## Entry conditions and recursion

- Always set entry conditions, and use "Only when a record is updated to meet the condition
  requirements" for update triggers; otherwise the flow runs on every save and re-fires on its own
  updates.
- One record-triggered flow per object per timing (before/after) unless there is a reason to
  order them explicitly (Flow Trigger Explorer, trigger order). A second flow on the same object
  and event is the first place to look for double updates.
- A flow updating the record it was triggered by, after-save, re-enters the save; use a before-save
  flow or a decision on the field already having the value.

## Bulk and limits

- Record-triggered flows run one interview per record but the platform batches DML across the
  200 records in a trigger batch. Never put Get/Create/Update inside a loop: collect, then one DML.
- Per transaction: 100 SOQL, 150 DML, 2,000 elements executed per interview. A data load of 200
  records hitting a flow with a Get inside a loop fails the whole load.

## Faults and testing

- Every Create/Update/Delete element gets a fault path. Without one, the user sees "An unhandled
  fault has occurred" and the record does not save. On the fault path, log or email, do not swallow.
- Flow tests (Setup > Flows > Tests) exist for record-triggered flows; production orgs can require
  75% flow test coverage before a flow can be deployed as Active.
- A deployed flow file with `<status>Active</status>` is activated on deploy and becomes the new
  active version. `Draft` deploys a new inactive version. Activating later is `flow_set_active_version`,
  a gated command.
- Deleting flow versions: only inactive versions, and not ones with paused interviews.

## Reading a flow

`flow_versions <DeveloperName>` for the active version, `read_metadata Flow <DeveloperName>` for
the XML. In the XML: `<start>` holds object, triggerType (RecordBeforeSave/RecordAfterSave/
Scheduled/PlatformEvent), recordTriggerType (Create/Update/CreateAndUpdate/Delete), filters and
`doesRequireRecordChangedToMeetCriteria`. `<scheduledPaths>` hold the async path
(`<pathType>AsyncAfterCommit</pathType>`) and the timed paths. Elements connect through
`<connector><targetReference>`.

## XML essentials for builders

`<apiVersion>`, `<processType>` (AutoLaunchedFlow for record- and event-triggered, Flow for screen
flows), `<status>`, `<start>`, elements with `<name>`, `<label>`, `<locationX>`/`<locationY>`,
`<connector>`; DML elements with `<faultConnector>`; variables with `<dataType>`, `<isCollection>`,
`<isInput>`/`<isOutput>`. Read the existing version first and keep element names, or the diff is
unreadable and existing tests break.
