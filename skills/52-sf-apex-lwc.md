---
name: Salesforce Apex and LWC
kind: knowledge
scope: global
roles: []
---
# Salesforce Apex and LWC

Load when the change needs code: an Apex trigger, class, test, asynchronous job, or a Lightning Web Component, or when debugging an Apex exception.

## When Apex is justified

Only when Flow genuinely cannot: complex bulk logic with many objects, callouts with retry logic,
recursion control, heavy collections, a queueable chain, an operation Flow lacks. Name the reason
in the plan. Everything else is a Flow, and the reviewer will say so.

## Order of execution (one save)

System validation → before-save flows → before triggers → custom validation rules → duplicate
rules → record saved (not committed) → after triggers → assignment, auto-response, workflow
rules → escalation → after-save flows → entitlements → roll-up summaries on parents → sharing
recalculation → commit → post-commit work: email, async flow paths, platform events (Publish
After Commit), queueables. A before-save flow sees the record before triggers; an after-save flow
sees the trigger's changes. An exception anywhere before commit rolls the whole save back.

## Governor limits (synchronous)

100 SOQL queries, 150 DML statements, 10,000 DML rows, 50,000 query rows, 10 s CPU, 6 MB heap,
100 callouts, 10 future calls. Async doubles CPU (60 s) and heap (12 MB). A trigger runs once per
batch of up to 200 records: no SOQL or DML in loops, ever.

## Trigger pattern

One trigger per object, no logic in it, a handler class per object with static recursion guard.
Check for an existing trigger or framework before adding one; two triggers on the same object with
no defined order is the first suspect for double processing. Bulkify against `Trigger.new` and
`Trigger.oldMap`; use `Trigger.isBefore` for field updates on the same record (no DML needed).

## Sharing and security in code

`with sharing` / `without sharing` / `inherited sharing` control record visibility only. CRUD and
FLS need `WITH USER_MODE`, `AccessLevel.USER_MODE`, or `Security.stripInaccessible`. Guest and
community users hit Apex through `@AuraEnabled` and REST; the class must be on their profile.

## Asynchronous options

- `@future`: fire and forget, primitives only, no chaining.
- Queueable: objects as state, chainable, `System.enqueueJob`, one chained job per transaction.
- Batch Apex: large data volumes, `Database.Batchable`, 200 per execute by default.
- Schedulable: cron with `System.schedule`; prefer a schedule-triggered flow for record updates.
- Callouts cannot follow DML in the same transaction ("uncommitted work pending"): move the callout
  to a queueable or the after-commit path.

## Tests

75% org-wide coverage to deploy Apex to production; every trigger needs some coverage. Tests
create their own data (`@TestSetup`), never `SeeAllData=true`, assert behaviour with messages, and
cover positive, negative and bulk (200 records) cases. `Test.startTest()`/`stopTest()` reset
limits and run async work. `System.runAs(user)` for permission tests. Deploy with
`RunSpecifiedTests` naming the test classes, or `RunLocalTests` when policy requires.

## Reading an Apex failure

`get_apex_logs` then `get_apex_log_body`: look for `EXCEPTION_THROWN`, `FATAL_ERROR`,
`LIMIT_USAGE_FOR_NS`, `DML_BEGIN`/`DML_END`, `FLOW_ELEMENT_ERROR`, `VALIDATION_RULE`. The line
number in `System.DmlException` points at the DML, not at the cause; read the message
(`FIELD_CUSTOM_VALIDATION_EXCEPTION`, `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY`,
`REQUIRED_FIELD_MISSING`, `DUPLICATE_VALUE`). Empty logs mean no trace flag: `set_trace_flag`, ask
the user to reproduce, read again.

## LWC

- Files: `.html`, `.js`, `.js-meta.xml` with `<isExposed>` and `<targets>` (record page, app page,
  Experience site page). Light DOM is opt-in; shadow DOM is the default.
- Data: `lightning-record-form` / `lightning-record-edit-form` and `getRecord` use the UI API and
  respect FLS; `@AuraEnabled(cacheable=true)` Apex for reads, non-cacheable for writes, and the
  Apex must check access itself.
- `@wire` for reactive reads, imperative calls for actions; `refreshApex` after a write.
- On Experience sites the guest profile needs the Apex class and the component's target must include
  the site page type. The browser's console and network tabs (`read_console_logs`,
  `read_network_requests`) show what the component actually sent when nothing else does.
