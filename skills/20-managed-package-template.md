---
name: Managed package knowledge (template — edit me)
kind: knowledge
scope: global
roles: []
enabled: false
---
# Managed package: <Package name> (namespace `<ns>__`)

> Super admin: duplicate this skill per managed package your agency ships, fill it in and enable it. Scope it to a client when the package is only installed there.

## What it does
Short description of the package's business purpose and the objects it owns.

## Data model
| Object | API name | Purpose | Key fields |
|---|---|---|---|
| Contract | `ns__Contract__c` | ... | `ns__Status__c`, `ns__End_Date__c` |

## Automation shipped with the package
- Flows: `ns__Contract_Renewal` (record-triggered after save on Contract) — sets `ns__Renewal_Due__c` ...
- Triggers: `ns__ContractTrigger` → `ns__ContractTriggerHandler` — bypass via Custom Setting `ns__Bypass__c`.
- Scheduled jobs: ...

## Extension points (what implementers may customise)
- Add unmanaged fields to package objects and expose them via the `ns__Contract_Fieldset` field set.
- Subscribe to platform event `ns__ContractEvent__e` instead of writing triggers on package objects.
- Global Apex interfaces: `ns.RenewalPlugin` — implement and register in Custom Metadata `ns__Plugin__mdt`.

## Do NOT
- Never edit package validation rules, flows or layouts (they are overwritten on upgrade).
- Never rely on undocumented package fields.

## Known issues / gotchas
- ...
