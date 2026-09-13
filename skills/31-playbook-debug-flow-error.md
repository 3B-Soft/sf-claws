---
name: Playbook — debug a flow error
kind: playbook
scope: global
roles: [orchestrator, analyst, flow_builder]
---
# Playbook: debug a flow error ("An unhandled fault has occurred...")

1. Identify the flow: from the page context (flow id), the error email, or `soql_query` on `FlowInterview`/`FlowExecutionErrorEvent` if available; otherwise `list_metadata Flow` and match by name.
2. `flow_versions <DeveloperName>` to see the active version; `read_metadata Flow <DeveloperName>` for the XML.
3. Find the failing element: look at `get_apex_logs` → `get_apex_log_body` for `FLOW_ELEMENT_ERROR`, `FLOW_START_INTERVIEW`, `VALIDATION_RULE` and DML exceptions (FIELD_CUSTOM_VALIDATION_EXCEPTION, REQUIRED_FIELD_MISSING, INSUFFICIENT_ACCESS).
4. Explain the root cause in business terms: "The flow tries to update the Account's Industry to a value that is not in the picklist" etc.
5. Propose the fix (flow change, validation rule change, data fix, permission). Only stage a change when the user agrees; add a fault path if missing.
6. Validate, confirm, deploy, document — including how the user can verify (re-run the scenario).
