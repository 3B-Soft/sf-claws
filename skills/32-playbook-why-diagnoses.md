---
name: Playbook — why is this happening
kind: playbook
scope: global
roles: [orchestrator, analyst]
---
# Playbook: why is this happening

Load when the user asks why: cannot see or edit something, an automation did not fire, an email never arrived, a save errors, or where a value came from.

Run the checks in order and stop at the first one that explains it. Quote the evidence (query
result, rule text, log line) in the answer; do not theorise past the first solid finding. Ask the
user to reproduce before reading logs, and `set_trace_flag` first if `get_apex_logs` is empty.

## 1. "Why can't user X see or edit this field / record?"

1. `describe_sobject` the object: does the field exist, is it a formula (read-only by nature).
2. FLS: `SELECT Parent.Name, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType='Obj' AND Field='Obj.Field__c'`
   then `SELECT PermissionSet.Name FROM PermissionSetAssignment WHERE AssigneeId='<user>'`. No
   overlap means no access; the fix is the persona's existing permission set.
3. Object permissions: `ObjectPermissions` for the same parents.
4. Record access: `SELECT HasReadAccess, HasEditAccess, MaxAccessLevel FROM UserRecordAccess WHERE UserId='<user>' AND RecordId='<id>'`;
   if false, org-wide default and sharing rules (`read_metadata` the object's sharing settings,
   `list_metadata SharingRules`).
5. UI: `read_metadata Layout` for the layout assigned to their profile and record type, or the
   record page (`FlexiPage`); the field may simply not be placed.
6. Guest user: none of the above applies the same way. Guest sharing rules only, Read only, no
   Edit on standard objects; see "Salesforce security and guest users".

## 2. "Why didn't the automation fire / why didn't the field update?"

1. `flow_versions <name>`: is the version they expect the active one.
2. `read_metadata Flow <name>`: entry conditions and `doesRequireRecordChangedToMeetCriteria`; a
   record already meeting the condition does not re-trigger on update.
3. Timing: a before-save flow cannot see changes made by an after-save one; a scheduled path needs
   its date field populated at entry; an async path runs after commit and can fail alone.
4. Context: does the flow do an action (email, callout) as a user who cannot (guest, restricted).
5. Competing automation: `list_metadata Flow` filtered by the object, `soql_query` on `ApexTrigger`
   (tooling=true) for the object, workflow rules if the org still has them. Two writers to one field
   means the last one wins.
6. The log: `get_apex_logs` → `get_apex_log_body`, look for `FLOW_START_INTERVIEW`,
   `FLOW_ELEMENT_ERROR`, `FLOW_BULK_ELEMENT_LIMIT_USAGE`, and whether the flow name appears at all.

## 3. "Why did the email never arrive?"

1. Deliverability level (sandbox default "System email only"): ask, or read the org kind.
2. Sender: `SELECT Address, DisplayName, IsAllowAllProfiles FROM OrgWideEmailAddress`; the
   flow's Send Email or email alert sender setting from `read_metadata`.
3. Who ran the transaction: a guest user or a user whose profile may not use the OWA. If guest,
   the fix is the platform-event route, not a different template.
4. Recipient: the Contact's email, `HasOptedOutOfEmail`, bounce fields.
5. Evidence: `SELECT Subject, ToAddress, Status, CreatedDate FROM EmailMessage WHERE ... ORDER BY CreatedDate DESC LIMIT 20`,
   the flow fault path's output, the debug log's `SendEmail` lines, the org's email log export.
6. Limits: `get_org_limits` for `SingleEmail`.

## 4. "Why does saving give this error?"

Match the error text first, then read the source of it:

- "FIELD_CUSTOM_VALIDATION_EXCEPTION" or a business sentence in red: a validation rule.
  `soql_query` (tooling=true) `SELECT ValidationName, Active, ErrorMessage, ErrorConditionFormula FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Obj'`.
- "An unhandled fault has occurred in this flow": a flow DML element without a fault path;
  playbook "debug a flow error".
- "Apex trigger X caused an unexpected exception": `get_apex_logs` for the `EXCEPTION_THROWN` line.
- "REQUIRED_FIELD_MISSING": layout or universally required field, often set by a flow that ran
  earlier and blanked it.
- "INSUFFICIENT_ACCESS_OR_READONLY" / "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY": section 1,
  usually the lookup target's sharing, or a guest user.
- "DUPLICATES_DETECTED": a duplicate rule; `list_metadata DuplicateRule`.
- "UNABLE_TO_LOCK_ROW": concurrent automation on the parent; look for a roll-up or a flow updating
  the parent from every child.

## 5. "Where does this value come from / why is the data wrong?"

1. `describe_sobject`: formula or roll-up (then the answer is the formula text, `read_metadata CustomField`).
2. Field history: `SELECT Field, OldValue, NewValue, CreatedBy.Name, CreatedDate FROM <Obj>History WHERE ParentId='<id>' ORDER BY CreatedDate DESC`
   (tracking must be on). `LastModifiedBy` being an integration or Automated Process user names
   the writer.
3. Writers: flows on the object with an Update to that field (`read_metadata Flow` for each
   candidate, grep the XML for the field API name), triggers, workflow field updates, and the
   managed package's own automation (`list_installed_packages`).
4. Loads: `CreatedBy`/`LastModifiedBy` and the Setup Audit Trail for Data Loader sessions or bulk jobs.
5. If nothing in the org writes it, the integration does: `read_network_requests` when the user
   reproduces it in the browser, otherwise ask which system syncs the object.
