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

## The ladder

Stop at the first rung that holds.

1. **Does this need to exist at all?** A speculative field nobody will fill, a flow for a case that
   has not happened: say so in one line and move on.
2. **Does the org already have it?** Describe the object, list the flows, read the permission sets
   before creating anything. Re-creating what already exists, under a slightly different name, is
   the most common waste in a Salesforce org and it is permanent.
3. **Configuration before automation.** Formula field, roll-up summary, validation rule, default
   value, required checkbox, list view, path, dynamic forms. No Flow for what a formula does.
4. **Automation before code.** A record-triggered Flow before an Apex trigger. Write Apex only when
   the requirement genuinely exceeds Flow, and name the reason in the plan: callouts, complex bulk
   behaviour, recursion control, an operation Flow does not support.
5. **Standard before custom.** A standard object or field before a custom one; a standard report
   type before a custom one.
6. **Extend before duplicate.** Add the field to the existing permission set and the existing
   layout; add the branch to the existing flow. A second parallel automation on the same object is a
   future bug.
7. **Then:** the smallest correct change, in the fewest components.

Two rungs both work? Take the higher one and move on.

## Fixing a bug

**Root cause, not symptom.** A report names one path. Before you change anything, find every path
that shares the cause: the validation rule that blocks this profile probably blocks four others, the
flow fault is in the element, not in the record. One fix where everything routes through beats a
patch per caller, and it is the smaller change.

## Rules

- No scaffolding for later. No field "we will need eventually", no custom setting nobody reads, no
  permission set with one member and no plan for a second.
- Prefer deleting configuration to adding it. Never deactivate or delete existing automation without
  the user explicitly asking and understanding what stops working.
- Boring over clever. The next person to open this org has no context and no patience.
- A deliberate corner with a known ceiling gets written down in the documentation: what it does not
  handle, and what to do when it stops being enough.

## Never simplify away

Field-level security and sharing, data integrity rules that prevent bad records, test coverage where
policy requires it, error handling in Flow (fault paths) and Apex, accessibility of anything users
see, and anything the user explicitly asked for. If the user wants the fuller version after you
offered the lean one, build it and do not re-argue.

## Saying it

In the plan and in chat: what you will change, and one line on what you skipped and when it would be
worth adding. If your explanation is longer than the change, cut the explanation.

Explanation the user actually asked for is not waste. A report, a walkthrough, a summary of what was
deployed: give it in full. The rule is only against prose nobody asked for.
