# SF Claws Privacy Policy

Effective 15 September 2026. Applies to the SF Claws Chrome extension published by 3B.

## The short version

3B does not receive, store, process or sell any of your data. The extension talks only to an SF Claws
server that your own organisation runs. 3B has no access to that server, no telemetry from the
extension, and no way to see what you do with it.

## What the extension handles

The extension is a client for a self-hosted server. To do its job it handles:

- **Authentication information.** A sign-in token for your organisation's SF Claws server. It is kept
  in Chrome's local extension storage on your machine and sent only to that server.
- **Settings.** The server URL and display preferences, kept in Chrome's extension storage and synced
  by Chrome to your other signed-in browsers if you have Chrome sync enabled.
- **Salesforce page context.** The URL of the Salesforce tab you are working in, so the assistant
  knows which object, record or setup page you are looking at. This is read only on Salesforce org
  domains and sent only to your organisation's server, with each message you send.
- **Browser console and network errors.** Only when you ask the assistant to look at them, the
  extension records JavaScript errors and failed network calls from the Salesforce tab a session is
  open on. Credential-shaped query parameters are removed from URLs before anything is recorded. The
  recording stops when the page navigates.
- **Your messages to the assistant.** Sent to your organisation's server, which processes them with
  the AI provider your administrator configured.

## Where the data goes

Everything above is sent to one place: the SF Claws server URL that you or your administrator entered
in the extension's settings. Nothing is sent to 3B or to any other third party by the extension.

What happens to data once it reaches that server is governed by your organisation, which operates
the server, and by the AI provider your administrator has connected to it. Ask your administrator
for your organisation's own data-handling terms.

## What 3B collects

Nothing. The extension contains no analytics, crash reporting, advertising or tracking of any kind,
and does not contact any 3B service.

## Data retention and deletion

The token and settings stay in Chrome's extension storage until you sign out, clear them on the
options page, or uninstall the extension. Uninstalling removes everything the extension stored.
Data held on your organisation's server is retained under your organisation's own policies.

## Permissions

The extension's Chrome permissions and the reason for each are listed in the Chrome Web Store
listing and in [PUBLISHING.md](PUBLISHING.md#5-permission-justifications).

## Changes

Changes to this policy are published at this URL with a new effective date.

## Contact

Privacy questions about the extension: privacy@3b4sf.com. Questions about how your organisation
handles data on its SF Claws server go to your administrator.
