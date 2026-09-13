## What this changes

## Why

<!-- The reason is the expensive part to recover later. What breaks without this? -->

## How it was verified

<!-- `npm run lint && npm run typecheck && npm test` is the baseline, not the answer.
     What did you actually exercise? For agent behaviour, what did you expect the model to do
     differently, and how did you check? -->

## Checklist

- [ ] `npm run lint && npm run typecheck && npm test` pass
- [ ] Contract changes went into `packages/shared` first, and shared was rebuilt
- [ ] Any schema change is a **new** migration entry, not an edit to an applied one
- [ ] Any tool that touches a Salesforce org goes through `runtime.gate()` and takes a `reason`
- [ ] New tools declare `readOnly`, and `concurrencySafe` only when genuinely safe in parallel
- [ ] Tenant-scoped queries carry a scoping predicate (the isolation test enforces this)
- [ ] Tests cover the behaviour, not just the happy path
