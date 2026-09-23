---
name: Playbook — investigate a data question
kind: playbook
scope: global
roles: [orchestrator, general, explore, plan, verify]
---

# Playbook: investigate a data question

Load when the user asks about records rather than configuration: how many, which ones, what
changed, who changed it, why a record has a value, whether data is duplicated, missing or
inconsistent, or when data must be understood before a fix.

The job is an answer with evidence: numbers, the queries that produced them, and the assumptions
behind them. Read-only by default. Nothing here changes a record.

## 1. Pin down the question

Turn the request into something a query can answer, and state it back when it is ambiguous:

- **What is counted or listed**: which object, which records ("active customers" is a definition,
  not a field).
- **Filters and time window**: "this quarter" in whose fiscal year, which date field (created,
  closed, last modified, a custom date).
- **The shape of the answer**: a number, a breakdown, a list of ids, a timeline for one record.

If two readings give different answers, pick the likelier, say which, and offer the other. Ask only
when the readings differ so much that guessing wastes the whole investigation.

## 2. Learn the data model on the fly

Do not assume standard behaviour; orgs rename, repurpose and extend.

1. `search_memory` for the object or term: an earlier session may already define "active customer".
2. `list_sobjects` with a filter to find the object(s); custom objects may hold what standard ones
   usually do.
3. `describe_sobject`: field labels, types, picklist values, `referenceTo`, formula text and help
   text tell you what a field means. `include: ['recordTypeInfos']` when record types split data.
4. Sample before you conclude: `SELECT … LIMIT 5` of real records shows which fields are actually
   populated and how (a picklist that is always blank, a text field holding dates).
5. Find where values come from when it matters: flows and triggers on the object (see "Playbook —
   why is this happening"), integration users in `CreatedBy`/`LastModifiedBy`, external id fields.
6. Write what you learned (definitions, key fields, gotchas) to the scratchpad with
   `scratchpad_write` as you go, e.g. "Opportunity data notes". Later questions in the session, and
   the documentation written at the end, build on it.

## 3. Query like it costs something

- **Count before you fetch.** `SELECT COUNT() FROM …` or `COUNT(Id)` first. Aggregate
  (`GROUP BY`, `SUM`, `MIN`, `MAX`, `HAVING`) to answer "how many / how much" without pulling rows.
  `soql_query` returns at most 2,000 records per call; never page through thousands of rows to
  count them by hand.
- **Explicit fields, always a `LIMIT`**, and only the fields the answer needs.
- **Filter on indexed fields** on large objects: `Id`, `Name`, `OwnerId`, `CreatedDate`,
  `SystemModstamp`, `RecordTypeId`, lookups, external ids. A non-selective filter on a big object
  times out; narrow by date first.
- **Date literals** (`THIS_QUARTER`, `LAST_N_DAYS:30`, `THIS_FISCAL_YEAR`) respect the org's fiscal
  settings and timezone; prefer them to hand-built ranges. Datetimes are stored in UTC.
- **Nulls are explicit**: `Field__c = null`. A blank picklist is null, not `''`.
- **Relationships**: parent fields with dot notation (`Account.Industry`), children with a
  subquery (`(SELECT Id FROM Contacts)`), anti-joins with `Id NOT IN (SELECT AccountId FROM …)`.
- If `GROUP BY` is rejected the field is not groupable (long text, some formulas); group on
  something else or sample.

Useful shapes:

| Question                          | Query                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Duplicates                        | `SELECT Email, COUNT(Id) n FROM Contact WHERE Email != null GROUP BY Email HAVING COUNT(Id) > 1 LIMIT 200`   |
| Orphans                           | `SELECT COUNT() FROM Contact WHERE AccountId = null`                                                         |
| Fill rate of a field              | `SELECT COUNT(Id) total, COUNT(Field__c) filled FROM Obj__c`                                                 |
| Distribution                      | `SELECT StageName, COUNT(Id) FROM Opportunity WHERE CloseDate = THIS_YEAR GROUP BY StageName`                |
| Parents without children          | `SELECT COUNT() FROM Account WHERE Id NOT IN (SELECT AccountId FROM Opportunity)`                            |
| Who loaded or changed records     | `SELECT LastModifiedBy.Name, COUNT(Id) FROM Obj__c WHERE LastModifiedDate = LAST_N_DAYS:7 GROUP BY LastModifiedBy.Name` |
| Ownership skew                    | `SELECT OwnerId, COUNT(Id) n FROM Account GROUP BY OwnerId HAVING COUNT(Id) > 10000`                         |

## 4. "What changed, when, and who did it"

- Field history: `SELECT Field, OldValue, NewValue, CreatedBy.Name, CreatedDate FROM
  <Object>History WHERE ParentId = '<id>' ORDER BY CreatedDate DESC` (`OpportunityFieldHistory`,
  `<Custom>__History` for custom objects). Only tracked fields appear, and only from when tracking
  was switched on; say so when the field is not tracked.
- Opportunities also keep `OpportunityHistory` (stage, amount, close date snapshots).
- `CreatedBy`, `CreatedDate`, `LastModifiedBy`, `LastModifiedDate` on the record itself; an
  integration or automated process user there usually means the value came from outside or from
  automation, not a person.
- Deleted records are not returned by normal queries. Say that a record may be in the recycle bin
  (15 days) rather than claiming it never existed.
- Configuration changes (who changed a field, rule or flow) are in `SetupAuditTrail`, not data
  history.
- For "why does this record have this value", trace the writers: history row, then the automation
  on that object and field (flows, triggers, workflow updates), then integrations.

## 5. Mind visibility and privacy

- Queries run as the connected integration user, who may see more (or less) than the person asking.
  When the question is "what does user X see", check their access (`UserRecordAccess`,
  permissions) rather than assuming the result matches their view.
- Personal data: aggregate first, list only what the question needs, and do not paste emails,
  phone numbers or other personal fields into the answer when a count or an id answers it.

## 6. Answer

- Lead with the answer in one sentence and the number(s).
- Then the evidence: the query (or queries), the definition and time window used, and anything
  excluded (record types, test data, inactive owners).
- Then caveats that could change the answer: untracked history, recycle bin, visibility of the
  integration user, a field that is only partly populated.
- For lists, show a small table and offer the full set, rather than pasting hundreds of rows.
- If the finding points to a data problem (duplicates, orphans, bad values), propose the fix
  separately and do not do it here: a small fix is a gated `update_record`; anything larger is a
  plan with a backup, a batch approach (Data Loader, a scheduled flow or batch Apex) and a
  rollback, approved by the user first. Also say what let the bad data in (missing validation rule,
  duplicate rule, integration mapping), since fixing the rows without the cause brings them back.
