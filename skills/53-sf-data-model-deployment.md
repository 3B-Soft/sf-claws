---
name: Salesforce data model and deployment
kind: knowledge
scope: global
roles: []
---
# Salesforce data model and deployment

Load when adding or changing fields, relationships, record types, formulas or validation rules, or when deciding how a change gets to the org.

## Fields

- Describe the object first (`describe_sobject`): a field with the same purpose may already exist,
  and a managed package field (`ns__Field__c`) may already carry the value.
- Types that are hard to change later: text length can grow, not shrink without data loss;
  changing a picklist to text or a lookup to master-detail is a rebuild; an auto-number or formula
  cannot become a normal field. Choose once.
- Formula fields: compiled size limit 5,000 bytes, 10 cross-object levels, no aggregate over child
  records (that is a roll-up summary). Formulas are read-only, evaluated on read, need no automation
  and no FLS beyond the field itself. First rung for "show me X derived from Y".
- Roll-up summary: only on the master side of a master-detail, COUNT/SUM/MIN/MAX, 25 per object.
  For lookups, a flow with a Get and an Update, or an installed roll-up tool.
- Picklists: restricted unless there is a reason; global value sets when the same values appear on
  several objects; record-type-specific values need a record type. Renaming a value with data in it
  is a data change, not metadata.
- Every new field needs field-level security through a permission set and, when the user should see
  it, a layout or record page placement. A field with no FLS is invisible to everyone but admins.

## Relationships

Lookup (optional, reparentable, no roll-ups) versus master-detail (required, cascades delete,
sharing inherited, roll-ups, must be created before data exists on the child or converted with
every child populated). Two master-details make a junction object. External ids for integration keys
(indexed, upsertable).

## Record types, layouts, record pages

Record types drive picklist values, page layout assignment and business process; they need a
profile or permission set assignment to be usable. Lightning record pages (FlexiPage) override
layouts for the section arrangement; the layout still governs which fields exist in the form and
related lists. Dynamic Forms put fields on the record page directly.

## Validation rules and duplicate rules

A validation rule fires on every save from every source, including data loads and flows; add a
bypass (a custom permission checked in the rule) before an integration user meets it. Error text
is what the user reads; write it as the fix, not the condition. Duplicate rules need a matching
rule and can block or alert; they also fire for guest-created records.

## Custom metadata and custom settings

Custom metadata types deploy with the org's configuration and are readable in formulas, flows and
Apex without SOQL limits; use them for configurable thresholds and mappings. Custom settings
(hierarchy) are for per-profile or per-user values. Neither is for data.

## Deployment mechanics

The step-by-step loop (package, validate, read errors, fix, deploy) is "Playbook — validate, fix and
deploy metadata"; this section is the platform rules it relies on.

- Source format, one file per component, package built from the workspace. `validate_deployment`
  is a `checkOnly` deploy: nothing changes until `request_deploy` and the user's confirmation.
- Test levels: `NoTestRun` is refused in production when Apex is included; `RunLocalTests` runs
  every non-managed test and needs 75% coverage; `RunSpecifiedTests` runs named classes, each of
  which must cover the deployed Apex.
- Profiles and permission sets deploy as partial files: only what is in the file is set, nothing
  else is removed. Layouts deploy whole: read the current one first or fields disappear.
- Deletion is a separate operation (destructive changes); `component_dependencies` first, and it is
  gated. A field with data is deleted to the recycle bin for 15 days.
- Managed package components: you cannot deploy changes to `ns__` metadata. You can add your own
  fields to their objects, place their fields on your layouts, grant their fields in your permission
  sets, and write flows on their objects.
- A flow deploys as a new version; `Active` activates it on deploy. In a production or protected
  org deploy as `Draft` unless activation was explicitly agreed.
- Post-deploy the harness reads every component back. Missing means missing; say so.
