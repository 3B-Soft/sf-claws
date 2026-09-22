---
name: Salesforce Apex and LWC
kind: knowledge
scope: global
roles: []
---

# Salesforce Apex and LWC

Load when the change needs code: an Apex trigger, class, test, invocable method, asynchronous job,
or a Lightning Web Component (including GraphQL queries and mutations in LWC), or when debugging
an Apex exception or a component that shows wrong or missing data.

## Before writing code

1. Retrieve existing triggers, handler classes and trigger frameworks on the object.
2. Check active record-triggered flows on the same object and event.
3. Check the org's API version and any namespace.
4. State in the plan why the declarative or GraphQL option is not enough (see below).
5. Write the test alongside the code, not after.

## When Apex is justified

Default to Flow for automation and to LDS/GraphQL for component data. Apex only when neither can:
complex bulk logic across many objects, callouts with retry logic, recursion control, heavy
collections, a queueable chain, an operation Flow and GraphQL lack, or elevated access the running
user must not have directly. Name the reason in the plan. When Flow needs one step it cannot do,
write an `@InvocableMethod` (it receives a list; bulkify it like a trigger) rather than moving the
whole process to Apex.

## Order of execution (one save)

System validation → before-save flows → before triggers → custom validation rules → duplicate
rules → record saved (not committed) → after triggers → assignment, auto-response, workflow
rules → escalation → after-save flows → entitlements → roll-up summaries on parents → sharing
recalculation → commit → post-commit work: email, async flow paths, platform events (Publish
After Commit), queueables. A before-save flow sees the record before triggers; an after-save flow
sees the trigger's changes. An exception anywhere before commit rolls the whole save back.

Two re-entry points cause most double processing: a workflow field update fires before and after
update triggers once more (validation rules do not re-run), and a roll-up summary puts the parent
through its own save, so parent triggers and flows run in the same transaction and share its
limits. Verify this list against current Salesforce docs when a debugging path depends on it.

## Governor limits (per transaction)

| Limit                 | Sync                      | Async                     |
| --------------------- | ------------------------- | ------------------------- |
| SOQL queries          | 100                       | 200                       |
| Query rows            | 50,000                    | 50,000                    |
| DML statements        | 150                       | 150                       |
| DML rows              | 10,000                    | 10,000                    |
| CPU time              | 10 s                      | 60 s                      |
| Heap                  | 6 MB                      | 12 MB                     |
| Callouts              | 100 (120 s total timeout) | 100                       |
| `@future` calls       | 50                        | 0 from future or batch    |
| `System.enqueueJob`   | 50                        | 1 from inside a queueable |
| `Messaging.sendEmail` | 10                        | 10                        |

A trigger runs once per chunk of up to 200 records: no SOQL or DML in loops, ever.

## Trigger pattern

One trigger per object, no logic in it, a handler class per object. Check for an existing trigger
or framework before adding one; two triggers on the same object with no defined order is the first
suspect for double processing. Bulkify against `Trigger.new` and `Trigger.oldMap`; use
`Trigger.isBefore` for field updates on the same record (no DML needed); switch on
`Trigger.operationType`.

Recursion guard: a `static Set<Id>` of processed record IDs, never a `static Boolean`. Statics
persist across the 200-record chunks of one DML, so a Boolean guard silently skips records 201+.
Add a bypass switch in Custom Metadata so admins can disable the handler without a deployment.

## Errors, configuration and callouts

- User-facing trigger errors: `record.addError()` or `record.Field__c.addError()`, not throws.
- Partial success: `Database.insert(records, false)` and inspect each `SaveResult`.
- Mixed DML (User, PermissionSetAssignment, Group with non-setup objects) needs a separate
  transaction (queueable), or `System.runAs` in tests.
- Configuration, thresholds and IDs live in Custom Metadata Types, never hardcoded.
- Callouts use Named Credentials and External Credentials; never hardcode endpoints or secrets.
- Callouts cannot follow DML in the same transaction ("uncommitted work pending"): move the callout
  to a queueable or the after-commit path.

## Sharing and security in code

`with sharing` / `without sharing` / `inherited sharing` control record visibility only. CRUD and
FLS need `WITH USER_MODE`, `AccessLevel.USER_MODE`, or `Security.stripInaccessible` (prefer user
mode over the older `WITH SECURITY_ENFORCED`). Guest and community users hit Apex through
`@AuraEnabled` and REST; the class must be on their profile.

## Asynchronous options

- `@future`: fire and forget, primitives only, no chaining.
- Queueable: objects as state, chainable, `System.enqueueJob`; up to 50 from a synchronous
  transaction, one child from inside a queueable.
- Batch Apex: large data volumes, `Database.Batchable`, 200 per execute by default (max 2,000).
- Schedulable: cron with `System.schedule`; prefer a schedule-triggered flow for record updates.

## Tests

75% org-wide coverage to deploy Apex to production; every trigger needs some coverage. With
`RunSpecifiedTests`, every class and trigger in the deployment needs 75% from the named tests
alone, so name all the relevant test classes. Use `RunLocalTests` when policy requires.

Tests create their own data (`@TestSetup`), never `SeeAllData=true`, and assert behaviour with
the `Assert` class and messages. Coverage without meaningful assertions is not acceptable. Cover
positive, negative and bulk (200 records) cases; a bug fix includes a test that reproduces the bug.
`Test.startTest()`/`stopTest()` give fresh limits and run async work. `System.runAs(user)` for
permission tests. `Test.setMock` with `HttpCalloutMock` for callouts (tests cannot call out).
`Test.getEventBus().deliver()` for platform event triggers.

## Reading an Apex failure

`get_apex_logs` then `get_apex_log_body`: look for `EXCEPTION_THROWN`, `FATAL_ERROR`,
`LIMIT_USAGE_FOR_NS`, `DML_BEGIN`/`DML_END`, `FLOW_ELEMENT_ERROR`, `VALIDATION_RULE`. The line
number in `System.DmlException` points at the DML, not at the cause; read the message.

| Message                                         | Usual cause                                             |
| ----------------------------------------------- | ------------------------------------------------------- |
| `FIELD_CUSTOM_VALIDATION_EXCEPTION`             | A validation rule; find which one in the log            |
| `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY` | No access to a referenced record (lookup, owner)        |
| `REQUIRED_FIELD_MISSING`                        | Missing field, often set by nothing in a new code path  |
| `DUPLICATE_VALUE`                               | Unique field or external ID collision                   |
| `Too many SOQL queries: 101`                    | Query in a loop, or recursion across triggers and flows |
| `Apex CPU time limit exceeded`                  | Nested loops, recursion, heavy flows on the same save   |
| `MIXED_DML_OPERATION`                           | Setup and non-setup DML in one transaction              |
| `UNABLE_TO_LOCK_ROW`                            | Contention on a shared parent, often parallel batches   |
| `List has no rows for assignment to SObject`    | Single-record query with no guard                       |
| `Maximum stack depth reached`                   | Runaway trigger recursion                               |
| `ENTITY_IS_DELETED`                             | Record deleted earlier in the transaction               |

Empty logs mean no trace flag: `set_trace_flag`, ask the user to reproduce, read again. Trace flags
expire and logs truncate at 20 MB, so a missing or cut-off log is not proof nothing ran.

## LWC

- Files: `.html`, `.js`, `.js-meta.xml` with `<isExposed>` and `<targets>` (record page, app page,
  Experience site page). Light DOM is opt-in; shadow DOM is the default.
- `@api recordId` is only populated on record pages.
- Import fields from `@salesforce/schema` rather than string names where the API allows it.
- Test with Jest (`sfdx-lwc-jest`), mocking wire adapters and imported modules.
- Lightning Message Service for communication between unrelated components.

### Data access: GraphQL first

New components get their data without Apex wherever possible. Choose in this order and stop at
the first that fits:

1. **Base record components** (`lightning-record-form`, `lightning-record-edit-form`,
   `lightning-record-view-form`) for a form over one record.
2. **GraphQL wire** (`graphql` from `lightning/graphql`) for every other read: lists, related
   records, several objects in one request, filtering, sorting, pagination, aggregates.
3. **`executeMutation`** from `lightning/graphql` for create, update and delete.
4. **Apex**, only for a reason from the list below, named in the plan.

Use `lightning/graphql`, not the older `lightning/uiGraphQLApi`, except for Mobile Offline, which
only the older module supports. Do not add a new `@AuraEnabled` method for a read or write that
GraphQL can do; when editing an existing component that uses Apex for simple reads, propose
migrating it rather than extending the Apex.

**Apex is still justified for component data when:** the object is not supported by UI API;
the component needs access the running user lacks (`without sharing` or system-mode logic, with
the reason documented); the operation needs a callout; the write must run server-side business
logic that cannot live in a trigger or flow; the query needs SOQL features the GraphQL API
lacks, more than 10 subqueries, or result volumes pagination cannot reasonably handle.

**Writing GraphQL queries:**

- Wrap queries in `gql` and always name the operation (`query OpenCasesForAccount`), which makes
  server-side debugging possible.
- Pass inputs through `variables`, exposed via a getter so the wire re-runs reactively. Never
  build query text by concatenating user input, even though v2 supports dynamic queries.
- Field values come wrapped: read `node.Name.value` (and `displayValue` for formatted output),
  under `uiapi.query.<Object>.edges[].node`.
- Only the first 10 records return by default; set `first` explicitly. Each query allows up to
  10 subqueries, each returning at most 2,000 records. For larger sets use cursor pagination
  (`first` and `after`); with `upperBound`, `first` must be 200 to 2,000 and the upper bound
  must stay constant for a given paginated collection.
- The adapter returns `errors` (an array), not `error`. Handle `data` and `errors` together:
  a response can carry partial data alongside errors.
- Queries run with the current user's object and field security. Use v2's optional-field
  support for fields some users cannot see, so one inaccessible field does not fail the query.
- Check field filterability before using it in `where`; not every field can be filtered.

**Writing mutations:**

- Call `executeMutation({ query, variables, operationName })` imperatively from an event
  handler, and check the returned `errors` before showing success.
- Mutations are ordinary saves: validation rules, duplicate rules, triggers and flows all run.
  A validation failure comes back in `errors`; surface its message to the user.
- After a create or update, call `refresh` on the stored wire result, since new or changed
  records are not guaranteed to appear in existing query results. Deletes are removed from
  wire results automatically.
- When several writes must succeed or fail together and you are not certain the mutation gives
  that guarantee, check the current GraphQL mutation docs; if it cannot, use Apex.

**Other data paths:** `getRecord` and other UI API adapters remain fine for a single record's
fields. When Apex is justified, use `@AuraEnabled(cacheable=true)` for reads and non-cacheable
methods for writes, the Apex checks access itself, `refreshApex` works only on the stored
value from a wired property or function, and `notifyRecordUpdateAvailable` tells other
components on the page to refresh after an imperative write.

### Experience sites

The guest or community profile needs object and field access for GraphQL queries to return data,
and the Apex class on the profile if Apex is used; the component's target must include the site
page type. The browser's console and network tabs (`read_console_logs`, `read_network_requests`)
show the GraphQL request and its `errors` when nothing else does.

## Definition of done

- Bulk test with 200 records passes; no SOQL or DML in loops.
- User-mode access enforced in Apex; no hardcoded IDs, endpoints or secrets.
- User-facing errors surface through `addError` or the component UI.
- New LWC data access uses base components or GraphQL, or the plan names why Apex is needed.
- GraphQL operations are named, use variables, handle `errors`, and refresh after writes.
