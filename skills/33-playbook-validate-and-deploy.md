---
name: Playbook — validate, fix and deploy metadata
kind: playbook
scope: global
roles: [orchestrator, general, verify]
---

# Playbook: validate, fix and deploy metadata

Load when staged changes need to be packaged, validated against the org, repaired after a failed
validation, or deployed; and when verifying that a change is actually deployable.

The workspace is the package. Every file staged with `write_workspace_file` (and every deletion
staged with `delete_component`) goes into one deployment; there is no separate `package.xml` to
maintain. `validate_deployment` is a check-only deploy: it compiles, runs tests and rolls back.
Nothing changes in the org until `request_deploy` and the user's confirmation.

Who does what: builders (general) stage and fix; the verify agent validates, reads the result and
reports what failed and why, but does not edit or deploy; only the orchestrator calls
`request_deploy`.

## 1. Package: make the workspace complete and minimal

`list_workspace`, then check each item against this list before the first validation:

- **Companion files.** `classes/X.cls` needs `classes/X.cls-meta.xml`; a trigger needs its
  `-meta.xml`; an LWC bundle needs `.js`, `.html` (unless a service component) and
  `.js-meta.xml` in `lwc/<name>/`; the folder name, file names and the `apiVersion` must agree.
- **Dependencies.** Everything a component references must be in the org already or staged: a
  field used by a flow, a class used by a trigger, a custom label, a record type in a layout
  assignment, a static resource. If it is neither, stage it or the deploy fails.
- **Visibility travels with the field.** A new field needs a permission set (`fieldPermissions`)
  and, if users should see it, a layout or FlexiPage. A new class called from LWC or a flow needs
  `classAccesses` for the users who run it.
- **Whole-file types were read first.** Layouts, FlexiPages, flows, record types and value sets
  deploy whole: the staged file must be the current org version (`read_metadata`) plus your edit,
  or everything you left out is removed.
- **Partial-file types stay partial.** Profiles and permission sets set only what is in the file.
  Stage only the entries you are adding or changing, not a full retrieved profile (which would
  reassert hundreds of unrelated settings).
- **Nothing extra.** No unchanged files, no retrieved-but-unedited components, no tests for code
  you did not touch. Every extra component is another thing that can fail and another change the
  user did not ask for. `delete_workspace_file` to unstage.
- **Tests with code.** Every new or changed Apex class or trigger has a test class staged beside it.

## 2. Validate: small first, then the real thing

1. **Slice compile while building.** `validate_deployment` with `paths` set to the component(s)
   you just wrote compiles that slice and its staged dependencies. It is fast feedback, not a pass:
   the result says "SLICE COMPILE ONLY".
2. **Full validation before deploy.** `validate_deployment` with no `paths` and the right test level:
   - No Apex staged: `NoTestRun` where the org allows it.
   - Apex staged: `RunSpecifiedTests` with every test class that covers the staged classes and
     triggers. Each deployed class and trigger needs 75% from those tests alone, so name all of
     them. In production, or when policy requires it, `RunLocalTests`.
3. Record the result: component count, tests run and failed, coverage. `scratchpad_write` the
   failures when there are more than a handful, so the fix loop and other agents work from one
   list.

## 3. Read the failures

Each failure is `[Type] FullName line N: problem`. Read them like a compiler's output:

- **Fix the root, not the echo.** One missing field makes every flow, class, layout and permission
  set that mentions it fail. Find the component the others depend on (usually a field, object,
  class or label) and fix that; the rest often disappear.
- **Component failures before test failures.** Tests do not run meaningfully until everything
  compiles.
- **The line number is in the source-format file** for Apex and LWC; for XML types it is often the
  element that failed to parse, not the cause.
- **Read the whole message.** `FIELD_CUSTOM_VALIDATION_EXCEPTION` in a test names the rule's error
  text; `System.AssertException` gives expected and actual.

| Message (shortened)                                                         | Usual cause and fix                                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `No such column 'X__c' on entity 'Y'` / `Variable does not exist`           | Field or variable not in org and not staged, or API name misspelt. `describe_sobject`, then stage it or fix it.  |
| `Invalid type: X` / `Entity of type 'T' named 'X' cannot be found`          | Referenced class, object or component missing. Stage it, or correct the name (namespace prefix?).                |
| `Method does not exist or incorrect signature`                              | Wrong parameter types or a method that is not `public`/`global`. Read the called class.                          |
| `Error parsing file: Element {…}x invalid at this location`                 | XML elements out of order or wrong parent. Metadata XML is order-sensitive: copy the order from `read_metadata`. |
| `An object 'X' of type T was named in package.xml, but was not found`       | Path or file name wrong, or the `-meta.xml` companion is missing.                                                |
| `Invalid reference Obj.Field of type sobjectField in file x.js`             | LWC `@salesforce/schema` import of a field that does not exist or is misspelt.                                   |
| `You cannot deploy to a required field`                                     | Permission set grants FLS on a required field. Remove that `fieldPermissions` entry.                             |
| `Picklist value: X in picklist: Y not found`                                | Record type or flow references a value not in the field. Add the value or fix the reference.                     |
| `Cannot change type due to existing data` / `Cannot change which object`    | Field type change the platform refuses. Needs a new field and a data migration; stop and re-plan.                |
| `Cannot modify managed object` / `… managed installed package`              | Staged a change to `ns__` metadata. Revert it; extend around the package instead.                                |
| `duplicate value found` / `DUPLICATE_DEVELOPER_NAME`                        | API name already used (maybe by a deleted component in the recycle bin, or a managed one). Rename.               |
| `The version of the flow you're updating is active and can't be overwritten` | Deploy the flow as a new version (it normally is); check the staged file is not pinned to an old version number. |
| `Average test coverage … is N%, at least 75%` / `Test coverage of selected Apex Trigger is 0%` | Missing or too-few test classes in `runTests`, or the test does not exercise the code. Add tests or name them. |
| Test failure with `FIELD_CUSTOM_VALIDATION_EXCEPTION` / `REQUIRED_FIELD_MISSING` | Test data does not satisfy the org's rules. Fix the test's data setup, never the rule.                    |
| Test failure with `MIXED_DML_OPERATION`                                     | Test inserts a User or permission assignment with other records: wrap setup in `System.runAs`.                  |

When a message is not in the table, search the exact text in product docs (`search_product_docs`)
before guessing.

## 4. Fix iteratively, and know when to stop

1. Fix the smallest set of roots that explains the failures. Change the staged file; do not
   stage workarounds (commenting out code, removing assertions, lowering a test level).
2. Re-validate. Slice compile the fixed component if many things are still broken; full validation
   once it compiles.
3. Compare with the previous attempt: fewer failures or different failures is progress; the same
   failures mean the fix did not address the root.
4. The harness refuses an unchanged failed payload and blocks after two no-progress compiles. Before
   the third attempt, stop and re-read: the assumption is wrong (wrong object, a field that
   exists only in another org, a managed dependency, a platform limit). Say so and re-plan, or ask
   the user.
5. A failure that needs something outside the approved plan (a new object, touching a protected
   component, changing a validation rule to make a test pass) goes back to the user, not into the
   workspace.

## 5. Deploy and prove it

1. `request_deploy` (orchestrator only) with a plain-language summary: what changes, who notices,
   any activation. It requires a clean validation of the current workspace; any edit after the
   validation means validate again.
2. Flows in production or protected orgs deploy as Draft unless activation was agreed.
3. After the deploy the harness reads every component back. Check the list: missing means
   missing, say so. Then prove behaviour, not just presence: `describe_sobject` for fields,
   `flow_versions` for the active version, a SOQL query or test run for data effects.
4. Tell the user anything the deploy cannot do: permission set assignments, activating a flow,
   adding a component to a page they chose not to change, data backfill.

## Verification verdict (verify agent)

Report PASS, FAIL or PARTIAL with evidence: the validation id and result, the tests and coverage,
and for each failure the root cause in one line and the file to change. Do not report a slice
compile as a pass. Do not propose weakening tests or rules to get to green.
