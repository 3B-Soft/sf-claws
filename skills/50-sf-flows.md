---
name: Salesforce flows
kind: knowledge
scope: global
roles: []
---

# Salesforce flows

Load when designing, changing or debugging a Flow: which flow type, entry conditions, async or
scheduled paths, running context, faults.

## Which flow type

| Need                                                              | Type                                              | Notes                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Set fields on the record being saved                              | Record-triggered, before-save (fast field update) | Can Get, Assign, Decide, Loop. Cannot create/update/delete other records, run actions or subflows. Cheapest and bulk-safe.          |
| Block a delete or react before it happens                         | Record-triggered, before-delete                   | Use Custom Error to block with a message.                                                                                           |
| Create/update related records, send email, call Apex after a save | Record-triggered, after-save                      | Same transaction. An unhandled failure rolls back the save; a fault path lets the save continue (see Faults).                       |
| Work after the save commits, outside the transaction              | After-save flow, **Run Asynchronously** path      | Separate transaction. Confirm the running user in the debug log before relying on it.                                               |
| Work later (N days after a date)                                  | After-save flow, **scheduled path**               | Check the date field is populated on entry. If the record stops meeting entry conditions, pending scheduled actions can be removed. |
| Recurring job over a set of records                               | Schedule-triggered flow                           | Runs as Automated Process; one interview per matching record.                                                                       |
| User interaction                                                  | Screen flow                                       | Runs as the user in front of it (guest included) unless `runInMode` says otherwise.                                                 |
| React to a platform event                                         | Platform-event-triggered flow                     | Runs as the Automated Process user (or the configured default), not as the publisher.                                               |
| Called from Apex or another flow                                  | Autolaunched                                      | Read `<runInMode>`; default mode depends on how it is launched. Do not assume it matches the caller.                                |

## Running context

- Record-triggered and schedule-triggered flows run in system context without sharing: object
  permissions, FLS and sharing are ignored for Get/Create/Update.
- Screen flows default to user context. Guest-user screen flows see only what guest sharing grants;
  set `SystemModeWithoutSharing` when the flow must read or write what the guest cannot, and keep
  what the guest can influence (inputs, filters) tightly constrained.
- Actions are not data. Send Email, callouts and invocable Apex in a record-triggered flow execute
  as the triggering user. A guest user's Send Email needs a verified org-wide email address; the
  reliable route is to publish a platform event and send from the event-triggered flow.
- When the running user matters (CreatedBy, email sender, a permission check), verify it in the
  debug log rather than from this table.

## Entry conditions and recursion

- Always set entry conditions, and use "Only when a record is updated to meet the condition
  requirements" for update triggers; otherwise the flow runs on every save and re-fires on its own
  updates.
- `$Record__Prior` is null on create. Guard any comparison against it in CreateAndUpdate flows.
- Multiple record-triggered flows on the same object and timing are fine only with an explicit
  trigger order (Flow Trigger Explorer, `<triggerOrder>`). Unordered siblings are the first place to
  look for double or conflicting updates.
- An after-save flow updating its own triggering record reruns the whole save (triggers, validation,
  flows). Use before-save, or a decision that skips when the field already has the value.

## Bulk and limits

- One interview per record, but the platform bulkifies Get/Create/Update across the interviews in a
  200-record trigger batch. Never put Get/Create/Update inside a loop: collect, then one DML.
- Per synchronous transaction: 100 SOQL, 150 DML statements, 10,000 DML rows, 10s CPU. In practice
  CPU time is what large flows hit first. (The old 2,000 executed-elements limit does not apply to
  flows on API 57.0+; check `<apiVersion>` on old flows.)

## Faults

- Every Create/Update/Delete and action element gets a fault path. Without one, the user sees
  "An unhandled fault has occurred" and the save rolls back.
- A fault path catches the error and the transaction continues: the record saves even though the
  failed element did nothing. Choose deliberately:
    - The save must not succeed without this step: Custom Error element (or Roll Back Records) with a
