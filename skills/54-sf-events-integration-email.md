---
name: Salesforce events, integration and email
kind: knowledge
scope: global
roles: []
---
# Salesforce events, integration and email

Load when the change sends email, publishes or subscribes to platform events, calls an external system, or must run as someone other than the triggering user.

## Email: what stops it sending

Check these in order; most "the email never arrived" reports end at one of them.

1. **Deliverability** (Setup > Deliverability): sandboxes default to "System email only" and send
   nothing; production needs "All email". Nothing else matters until this is right.
2. **Sender identity**. Options are the current user, the default workflow user, or an org-wide
   email address (OWA). An OWA must be verified (`SELECT Address, DisplayName, IsAllowAllProfiles
   FROM OrgWideEmailAddress`) and either allowed for all profiles or for the profile of the user
   whose transaction sends it. A missing or unverified OWA is the usual cause of a silent drop.
3. **Who is sending**. Email actions run as the transaction's user, including the async path of a
   record-triggered flow. A **guest user** cannot send email unless the sender is a verified OWA
   the guest profile may use, and even then site settings can block it. The dependable pattern:
   the guest transaction publishes a platform event, and a platform-event-triggered flow, running as
   the Automated Process user, sends the email from the OWA.
4. **The template and the recipient**: merge fields that resolve to nothing, a Contact with no
   email or "Email Opt Out", an invalid address, a bounced address (bounce management).
5. **Limits**: 5,000 external single emails per org per day through the API and Apex; flow Send
   Email actions count. Mass email has its own limits.
6. **Evidence**: `EmailMessage` records when Enhanced Email logs them, the flow's fault path, the
   debug log (`EMAIL_QUEUE`/`SendEmail` entries), and the Email Log export from Setup.

Email alerts (workflow-style) with a template are the configuration rung; the Send Email flow action
with rich text body is the next; Apex `Messaging.SingleEmailMessage` last.

## Platform events

- Custom events `Name__e` with custom fields; published from flows (Create Records on the event
  object), Apex (`EventBus.publish`) or the API. Publish Behavior: **Publish After Commit** (default,
  only when the transaction succeeds) or Publish Immediately (even on rollback; for logging).
- Subscribers: platform-event-triggered flows (run as the Automated Process user, or the running
  user set on the flow; this is how work escapes a guest or a restricted user's context), Apex
  triggers (`after insert`, run as Automated Process, retryable with `EventBus.RetryableException`),
  CometD/Pub-Sub API clients.
- The event is fire and forget from the publisher's side: log a correlation id on the event so a
  failure in the subscriber can be traced to the originating record.
- Change Data Capture publishes standard change events for selected objects; use it for
  integrations that mirror records, not for business logic.

## Callouts

- Named Credentials (with External Credentials for the auth) hold the endpoint and secret; Remote
  Site Settings are the legacy allow-list. Never hard-code a URL or a token in Apex or a flow.
- A callout cannot follow uncommitted DML in the same transaction; move it to the async path, a
  queueable, or an event subscriber. Flow HTTP Callout actions run synchronously in screen and
  autolaunched flows.
- Inbound: REST API and Composite API for records; Apex REST (`@RestResource`) for custom shapes,
  which needs the class on the caller's profile; an integration user with its own permission set,
  never a human's login.

## Running as someone else

Ways to change the identity a piece of work runs under: a platform event subscriber (Automated
Process user or the configured running user), a schedule-triggered flow, a scheduled Apex job
(scheduled by an admin, runs as that admin), a queueable enqueued from a trigger (still the
triggering user). Data access in record-triggered flows is already system context; it is the
actions, email above all, that need the switch.
