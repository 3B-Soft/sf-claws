# Harness recovery and hydration

This increment is covered by scripted providers, in-memory SQLite and mocked Salesforce connections.
No live Salesforce deployment was performed. Run a separately approved sandbox check-only smoke test
before relying on the Tooling integration in production operation.

## Recovery records

The `harness_recovery_hydration` migration adds checkpoint, remote-attempt and hydration tables plus
an org schema revision. It does not modify existing files, sessions or org metadata.

Each validation/deploy checkpoint retains its whole staged tree and immutable payload. Metadata
checkpoints include the exact ZIP bytes; Tooling checkpoints retain member IDs and bodies. Checksums
are verified before execution. Attempt records include submission/polling state, job/container IDs,
start/finish times, terminal outcomes and the next permitted platform retry time. Disk consumption
grows with archived source/ZIPs: include the SQLite database in encrypted backups and monitor disk.

One active or uncertain checkpoint reserves an org. An uncertain network response is not permission
to send another payload. Restarting the server, replacing an agent or starting another session cannot
discard this reservation. Agents are stopped before spending tokens while a remote job is unresolved.

## Authenticated endpoints

All paths below use the existing session membership/ownership checks under `/api/v1`.

- `GET /sessions/:id/checkpoints`: latest 100 checkpoint summaries.
- `GET /sessions/:id/checkpoints/:checkpointId`: archived tree/payload and attempts, including a
  quarantined candidate. These contain customer source; treat exports like the workspace itself.
- `POST /sessions/:id/checkpoints/:checkpointId/reconcile`: while the session is stopped, poll the
  acknowledged remote job. A Tooling container can recover its lost request ID. Remaining bounded
  check-only platform retries may continue; real deploys are never automatically resubmitted.
- `GET /sessions/:id/hydration`: full persisted evidence manifest.

Manual validation also reconciles an outstanding check-only checkpoint before doing anything new.
After reconciliation, run another full validation of the **current** workspace. The old job's success
does not approve edits made after its payload was archived.

If a Metadata submission lost its acknowledgement before any ID could be saved, automatic recovery
stops. Inspect Salesforce Deployment Status and the archived timestamps; there is deliberately no
blind "release lock and retry" endpoint. Manual operator investigation is required.

## Rollback semantics

Only comparable compiler checks are compared: same org/access/schema identity, API version, engine,
scope/path set, test selection and coverage policy. A larger root-component error count quarantines
the failed candidate and restores the previous checkpoint's complete **staged database workspace** in
one SQLite transaction. It then stops for manual validation. `restoredFrom` identifies the baseline;
the failed candidate remains downloadable. No Git stash/checkout or live-org rollback occurs.

## Git baseline and hydration

Provision an ordinary local checkout at `DATA_DIR/workspaces/<clientId>/<orgId>` if Git inspection is
desired. Use canonical paths (no symlinked checkout or `.git` indirection). The harness reads modified,
untracked and deleted paths, HEAD and recent history, and bounded changed Salesforce source files.
It does not fetch, clone, change branches, commit, or assert that `main` represents the live org.
Absent checkouts remain an explicit unavailable baseline in the manifest; targeted live reads still
run. Automatic baseline provisioning and admin org-to-Git synchronization are not part of this change.

Describes and exact Apex Tooling reads/metadata retrieves run before agent construction. Targets and
concurrency are capped; failure means unavailable, not absent. A second pass can discover new explicit
targets, but cannot initiate an unbounded scan. Raw evidence stays outside model history; prompts get
small projections with hashes and freshness. Sixty seconds is the cache/freshness window, not a
guarantee that external Salesforce edits cannot happen during that interval.

## Salesforce contract references

The fast path uses temporary member/container records and always sets `IsCheckOnly=true`; it never
creates live Apex stubs. Full validation and explicit test runs remain Metadata API operations. See
[ContainerAsyncRequest](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_containerasyncrequest.htm),
[ApexClassMember](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_apexclassmember.htm), and the
[Tooling API guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_tooling.pdf).
