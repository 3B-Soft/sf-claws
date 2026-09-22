---
name: Least resistance
kind: quality
scope: global
roles: []
---

# Least resistance

The best change is the one you did not have to make. Lazy here means efficient, not careless: a
smaller change is faster to validate, cheaper to deploy, easier for the next admin to understand and
far less likely to page someone at 3am.

Never be lazy about understanding the org. The ladder shortens the solution, never the reading.
Read what is already there first, then climb.

## Org safety

- Know which org you are connected to before every command. Say it in the plan.
- Production is read-only by default. Queries and describes are fine; DML, deploys, and destructive
  changes need explicit user approval each time.
- Validate (check-only deploy) before any real deploy, and run the relevant tests.
- Managed package components cannot be edited. Extend around them; never try to patch them.

## Reading the org

Before building, fixing or explaining anything on an object, know:

- Every automation on it, in order of execution: before-save flows, before triggers, validation and
  duplicate rules, after triggers, after-save flows, and any legacy Workflow Rules or Process
  Builders. Most bugs live in the interaction between two of these.
- Existing fields, record types, layouts/dynamic forms, and who can see them (FLS, sharing,
  permission sets and groups).
- The org's naming conventions. Follow them, even where you would have chosen differently.

## The ladder

Stop at the first rung that holds.

**What to build**

1. **Does this need to exist at all?** A speculative field nobody will fill, a flow for a case that
   has not happened: say so in one line and move on.
2. **Does the org already have it?** Re-creating what exists under a slightly different name is the
   most common waste in a Salesforce org, and it is permanent.
3. **Extend before duplicate.** Add the field to the existing permission set and layout; add the
   branch to the existing flow. A second parallel automation on the same object is a future bug.
4. **Standard before custom.** A standard object, field or report type before a custom one.

**How to build it** 5. **Configuration.** Formula field, roll-up summary, validation rule, default value, required
field, list view, path, dynamic forms. No Flow for what a formula does. 6. **Before-save Flow** for updates to the triggering record. No second DML. 7. **After-save or other Flow** for related records, notifications, and orchestration. 8. **Apex** only when the requirement genuinely exceeds Flow. Name the reason in the plan:
callouts, complex bulk behaviour, recursion control, an operation Flow does not support. 9. **Then:** the smallest correct change, in the fewest components.

Two rungs both work? Take the higher one and move on.

## Investigating

Reproduce first, then read: debug log, Setup Audit Trail, field history, flow interview errors, and
the automation list above. State what you found and the evidence for it before proposing any fix.
If you cannot reproduce it, say so rather than guessing.

## Fixing a bug

**Root cause, not symptom.** A report names one path. Before you change anything, find every path
that shares the cause: the validation rule that blocks this profile probably blocks four others; the
flow fault is in the element, not in the record. One fix where everything routes through beats a
patch per caller, and it is the smaller change.

## Rules

- No scaffolding for later. No field "we will need eventually", no custom setting nobody reads, no
  permission set that duplicates an existing one.
- Propose deleting unused configuration freely. Never deactivate or delete anything yourself unless
  the user explicitly asks and understands what stops working.
- Do not build new Workflow Rules or Process Builders. Note legacy ones you find; migrate only when
  asked.
- Design for bulk: every Flow and trigger must survive a 200-record data load within governor limits.
- Boring over clever. Fill in Description fields; the next person to open this org has no context
  and no patience.
- A deliberate corner with a known ceiling gets written down: what it does not handle, and what to
  do when it stops being enough.

## Never simplify away

Field-level security and sharing, data integrity rules that prevent bad records, Apex tests that
assert behaviour (not just coverage), fault paths in Flow and error handling in Apex, accessibility
of anything users see, and anything the user explicitly asked for. If the user wants the fuller
version after you offered the lean one, build it and do not re-argue.

## Done means

Tests pass, a validate deploy succeeds, and you have checked the behaviour as a user with the
affected profile or permission set, or told the user what still needs checking and why you could
not.

## Saying it

In the plan and in chat: what you will change, and one line on what you skipped and when it would be
worth adding. If your explanation is longer than the change, cut the explanation.

Explanation the user actually asked for is not waste. A report, a walkthrough, a summary of what was
deployed: give it in full. The rule is only against prose nobody asked for.
