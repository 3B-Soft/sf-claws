# Admin (end user) guide — Chrome side panel

1. Install the extension, open the side panel on any Salesforce tab, enter the server URL your agency gave you and pair the device (approve the code in the admin console). Your account must be approved first.
2. The panel shows which client org you are in and what you are looking at (record, object, setup page, flow). Start a session and describe what you need in business terms, e.g. "Sales users need a Renewal Date on Account, visible on the layout" or "Why can't Maria save this Opportunity?".
3. Watch the todo list and the agents work. Tool steps are summarised in plain language; switch to **Pro** to see raw SOQL/XML/JSON.
4. **Changes** shows every staged file with a visual before/after; **Validate** runs a check against the org without deploying. Nothing is deployed until you confirm: when the agent asks, on the approval card in Chat; when you press **Deploy** or **Commit to GitHub** on the Changes tab, on the confirmation shown right there, which names the exact command and what it will do. If anything was staged after the version you validated and approved, the deploy is refused and the changed files are named — you are never deployed something you did not see. Validations and deploys can take minutes; the panel waits and the result appears in the tab when Salesforce finishes.
5. Approval cards explain *why* the AI wants to run a command and *what* exactly it will run; choose Allow once, Allow for this session (when offered) or Deny. While a card is waiting the extension icon shows the count, and if the side panel is out of view you get a system notification (switch it off on the extension's Options page). The notification needs the side panel open somewhere: the panel is what listens to the session, so with it closed nothing can alert you.
6. The agent can read what your browser recorded (console errors, failed requests) when it asks and you have a session open on that tab: recording starts when the session opens, stays on that tab only, and credential-looking parameters (`sid`, `token`, ...) are scrubbed before anything is stored.
7. After a deploy the harness reads every component back out of the org and shows you what actually landed, with anything missing marked clearly. Then commit to GitHub when asked; documentation is written automatically to the Notes tab and the repository.
8. Rate the session (helpful / not helpful) — it helps your agency improve the harness.
9. If a session dies (server restart, closed laptop), open it again and press **Resume**; the harness continues from its saved todo list and notes.

Keep an eye on the API limits gauge; the harness warns when an org is close to its daily limits.

Long sessions fill up the model's memory. When yours is getting close you will see a banner: compact the session to keep going, or start a new one. Notes and documentation from earlier sessions carry the date they were written, because they describe the org as it was then.
