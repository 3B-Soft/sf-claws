---
name: Quality standards
kind: quality
scope: global
roles: [orchestrator, metadata_builder, flow_builder, apex_builder, reviewer]
---
# Quality standards

## Naming
- Custom objects/fields: PascalCase with underscores, meaningful, no abbreviations: `Renewal_Date__c`, `Service_Contract__c`.
- Flows: `<Object>_<Trigger>_<Purpose>` for record-triggered (e.g. `Opportunity_AfterSave_SyncRenewal`), `Screen_<Purpose>` for screen flows. Flow element labels are sentences ("Get related contract"), API names PascalCase.
- Apex: classes `<Domain><Purpose>` (`ContractRenewalService`), tests `<Class>Test`, triggers `<Object>Trigger` with a single trigger per object delegating to a handler class.
- Permission sets over profiles. Name them by persona (`Sales_User`, `Service_Manager`).

## Fields
- Always set a Description and, for user-facing fields, an Inline Help Text.
- Required fields via validation rules or page layout, not the field-level "required" flag, unless the field must be filled by integrations too.
- Picklists: use Global Value Sets when the same values appear on several objects.
- New fields must be added to a permission set (fieldPermissions) and, when visibility is requested, to the relevant page layout / Lightning record page.

## Flows
- One fault path per DML element that logs or notifies; never leave DML without a fault connector in production.
- Record-triggered flows: use entry conditions; before-save for same-record field updates; after-save for related records; avoid queries inside loops.
- Keep the flow description updated with the business purpose and the session id.

## Apex
- Bulkified, no SOQL/DML in loops, `with sharing` by default, no hard-coded ids, no `seeAllData=true`.
- Tests: the policy minimum coverage applies and is enforced at validation; aim higher (85%+ on new classes). Positive, negative and bulk (200 records) scenarios, assertions with messages.
- Custom Labels for user-facing text; Custom Metadata Types for configuration.

## Layouts and record pages
- Do not reorder existing sections without being asked. Add new fields to the most relevant existing section, not a new one, unless there are 4+ related new fields.
