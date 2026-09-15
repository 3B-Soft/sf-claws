---
name: Salesforce security and guest users
kind: knowledge
scope: global
roles: []
---
# Salesforce security and guest users

Load when the work touches who can see or do what: profiles, permission sets, sharing, field-level security, or an Experience Cloud site's guest user.

## The layers, and which one answers "why can't they"

1. **Licence and profile**: what the user could ever have. One profile per user.
2. **Object permissions (CRUD)** and **field-level security (FLS)**: granted by the profile and by
   permission sets. Grant new access with a permission set; profiles are the legacy vehicle and
   Salesforce is retiring permissions on them.
3. **Record access (sharing)**: org-wide defaults, role hierarchy, sharing rules, manual sharing,
   team sharing, Apex managed sharing. "View All"/"Modify All" on an object bypass sharing.
4. **UI**: page layout or record page, record type assignment, tab visibility, app assignment. A
   field the user can read but that is not on their layout is "missing" to them.

Check in that order, with queries, before theorising:

- `SELECT PermissionSet.Name, PermissionSet.IsOwnedByProfile FROM PermissionSetAssignment WHERE AssigneeId = '<user>'`
- `SELECT SobjectType, PermissionsRead, PermissionsEdit, PermissionsCreate, PermissionsDelete, Parent.Name FROM ObjectPermissions WHERE ParentId IN (<their sets>) AND SobjectType = 'X'`
- `SELECT Field, PermissionsRead, PermissionsEdit, Parent.Name FROM FieldPermissions WHERE SobjectType = 'X' AND Field = 'X.Field__c'`
- `SELECT RecordId, HasReadAccess, HasEditAccess, MaxAccessLevel FROM UserRecordAccess WHERE UserId = '<user>' AND RecordId = '<id>'`

## Permission set groups and muting

Bundle permission sets into a group per persona; muting permission sets remove specific
permissions from a group. Prefer adding to an existing set the persona already has over a new set
with one member.

## Guest users (Experience Cloud, Sites)

Each site has one guest user with its own guest profile. Since the "Secure guest user record
access" changes:

- Org-wide default for guest users is Private on every object and cannot be changed; role
  hierarchy and manual sharing do not apply. Only **guest user sharing rules** grant access, and
  they grant Read only.
- Guest profiles cannot hold Edit, Delete, View All or Modify All on standard objects. Create and
  Read remain. A public form that "updates a Contact" therefore does it through a screen flow in
  system context, or through Apex, never through the guest's own object permissions.
- Guest users cannot own records. Records they create are assigned to the site's default owner
  (Administration > Preferences in Experience Workspaces). Automation keyed on OwnerId must expect
  that user.
- Guest access to Apex: the class must be enabled on the guest profile for LWC/Aura `@AuraEnabled`
  methods and REST resources. Flows: the guest profile needs "Run Flows" and access to the flow.
- **Email**: a transaction running as the guest user cannot send email unless the sender is a
  verified org-wide email address that the guest profile is allowed to use. A Send Email action in
  a flow triggered by the guest's save (including its async path) is dropped or errors. Publish a
  platform event and send from the event-triggered flow, which runs as the Automated Process user.
- Guest user activity shows in logs as the site guest user (`SELECT Id, Name, Profile.Name FROM
  User WHERE UserType = 'Guest'`). Debug it with a trace flag on that user.

## Apex and security

- Apex runs in system mode. `with sharing` enforces record sharing; it never enforces CRUD or FLS.
  Enforce those with `WITH USER_MODE` in SOQL, `Database.insert(records, AccessLevel.USER_MODE)`,
  or `Security.stripInaccessible`.
- `without sharing` is a deliberate escalation: name the reason in the plan and in a class comment.
- Triggers and record-triggered flows both run in system context; the user's permissions are
  irrelevant to what they can update, which is exactly why a reviewer checks them.

## Reviewing a change for access

For every new field: which permission set gets FLS, which layout or record page shows it, does the
persona that triggers the flow actually have it. For every new flow or Apex: who runs it, in which
context, and what happens to the person without the permission set. A change that works for the
admin who tested it and silently fails for the user who triggers it is a blocker.
