---
name: Playbook — add a field and make it visible
kind: playbook
scope: global
roles: [orchestrator, metadata_builder]
---
# Playbook: add a field and make it visible

1. `describe_sobject` the object: confirm the field does not exist (also check similar labels) and note record types.
2. Ask (or infer from the request) the data type, length/precision, whether it is required, default value and help text.
3. Stage `objects/<Object>/fields/<Field__c>.field-meta.xml` with description + inline help text.
4. Permissions: `read_metadata PermissionSet <name>` for the persona's permission set, add `<fieldPermissions>` (editable + readable) and stage it. If no permission set exists for the persona, create `permissionsets/<Persona>.permissionset-meta.xml` and tell the user it must be assigned.
5. Visibility: `read_metadata Layout "<Object>-<Layout Name>"` and add a `<layoutItems>` with `<field>` into the right section; for Lightning record pages that use Dynamic Forms, edit the FlexiPage instead.
6. `validate_deployment`; fix until clean.
7. Summarise for the user in Setup terms, then `request_deploy`.
8. After deploy: remind the user to assign the permission set, and document.
