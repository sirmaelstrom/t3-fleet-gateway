# Changelog

## Unreleased

## 0.3.0 (2026-10-31)

### Upgrading

- **Migration 21, additive.** Adds optional client project policies; every existing client remains unrestricted. Existing grants, tokens, jobs and notification queues are unchanged. Back up with ledger users stopped. Older builds refuse schema 21; rollback restores the pre-upgrade backup and loses subsequent writes.

- **Migration 20, additive.** Adds safe bearer-token IDs and usage buckets, backfilling existing tokens without changing their values or grants. Stop all ledger users and back up before upgrading. Older builds refuse schema 20; rollback restores the pre-upgrade backup and loses later writes.

- **Migration 19, additive.** Adds persistent credential alerts and a separate outbox sharing webhook delivery health and retries; existing rows remain unchanged. Back up with all ledger users stopped. Older builds refuse schema 19; safe rollback restores the pre-upgrade backup and configuration, losing later writes. Existing connections keep their event selections; explicitly enable `credential_alert` and `credential_resolved` to receive them.

- **Migration 18, forward only.** Adds notification archive, job bindings and persistent delivery health without rewriting existing connection routes, revisions, queues or attempts. Archive/health begin at upgrade; no historical snapshots are invented. Stop all ledger users and back up before opening the new build. Older builds refuse the new schema; rollback requires restoring the pre-upgrade backup and loses subsequent writes. No key rotation or receiver re-registration is needed.

### Added

- Optional per-client project allowlists via `clients projects`: configured aliases or host/project IDs, intersected with machine access for discovery, jobs, feeds, attention, external threads and bot notifications. Lists apply across OAuth and bearer tokens, including rotation, without a restart. Notification capture, archive replay and pending delivery recheck policy; restricted clients do not receive aggregate cross-project connection history. Omitted policies keep existing behavior; an explicit empty list denies every project.

- Bearer tokens can rotate in place with an explicit overlap window (0 to 30 days), preserving bot identity and access. `clients tokens`, `clients rotate` and `clients revoke-token` expose safe token IDs, creation/expiry, last tool use and recent call counts, with immediate per-token or whole-client revocation. Migration 20 adds hash-linked token metadata and bounded hourly usage buckets, backfilling existing bearer tokens without changing their values or grants.

- T3 v0.1.6 project organization in `fleet_projects`: pinned and archived flags (null on older hosts), with archived-project guidance. Fork adoption/resume now requires a fresh listed conversation, excluding hidden side chats even when their ids are supplied directly. Existing jobs remain watched by their recorded thread id. See the [source compatibility review](docs/evidence/t3-v0.1.6.md); no live v0.1.6 qualification is claimed.

- Deduped downstream credential renewal-failure and configurable expiry alerts (default seven and two days), evaluated only after renewal fails so healthy cycles stay silent, with resolution after verified renewal, intersecting webhook/bot filters and shared delivery health. Current state is shown in the private dashboard and doctor.
- Confirmed private-dashboard re-pair through the existing configured pairing flow, verifying before atomically installing the replacement and resolving alerts. Failure keeps the old credential; confirmation retries reuse the result. Local enrollment/preflight diagnostics retain bounded stage, HTTP status, recognized error/denial code and command failure reason; raw upstream text, unknown codes and pairing material remain excluded, and notifications contain no diagnostic text.

- T3 launch retry keys, detected per session: supported launches carry a stable job-derived `clientRequestId` and allow one safe transport retry. Legacy marker reconciliation remains. Plain follow-up keys keep their format; uncertain retries are now durably bound to the original authorization identity across restarts. Older uncertain sends without identity metadata fail closed for inspection. Attachment follow-up handling is unchanged.
- `fleet_models.search` and per-provider `omittedModels`, with query-bound paging and fresh searches for explicit `work_start` validation at acceptance and dispatch. Older T3 hosts keep their legacy catalog. Upstream search is capped and excludes hidden models; see [contracts and limits](docs/evidence/launch-retries-model-search.md).
- Precise webhook job/original-client filters, intersected with existing host/project/event filters; optional precise filters in dashboard setup.
- Operator-provisioned bot-owned connections, `work_notifications`, `work_subscribe` and `work_replay`. Bots subscribe their own jobs with host-grant checks and bounded job bindings, without supplying destinations or credentials.
- Persistent per-connection delivery health in the dashboard, doctor and agent tools. Cursor/time replay through MCP or `webhooks replay` reuses original payloads and event IDs from a seven-day/10,000-event archive, including events omitted from a full pending queue. Retention gaps require durable feed catch-up. See [operations](docs/operations.md#precise-bot-notifications-and-recovery).
- Optional `standingInstructions` configuration text is prepended to every new job's first message ([#43](https://github.com/boundsj/t3-fleet-gateway/pull/43)). See [README](README.md#standing-instructions-for-workers) and [configuration](docs/configuration.md#standinginstructions).

### Fixed

- A queued job is no longer launched with a runtime mode broader than its project's current policy. Before every launch, alias jobs with or without a launch spec and discovered jobs now check the recorded runtime mode against the host access ceiling and the alias's or host's discovery `runtimeMode` as configured at dispatch; a job that exceeds either fails with `launch_policy_changed` and nothing is launched.
- CLI output escapes terminal control characters in stored values. `jobs list`, `clients list` tables, the job line `jobs adopt` prints and `clients scopes` show C0/C1 controls, DEL, Unicode line separators and bidirectional overrides as visible escapes (`\x1b`, `\u202e`), measured before columns are aligned, so a job title or client name can no longer clear or rewrite the operator's terminal. A literal backslash is shown doubled, so an escape in the output cannot be confused with text that merely looks like one. Stored values are unchanged.
- A client that disconnects from a 2026-era `subscriptions/listen` stream now releases its subscription. Each MCP exchange carries an abort signal tied to the client going away, and the response body is cancelled when the connection closes, so the SDK's listener, keep-alive and pending handler end with the client. Previously they stayed until the endpoint shut down. Ordinary requests and completed responses are unaffected.
- Preserve environment-scoped T3 v2 thread links from autolink and bare responses through launch, reconciliation, adoption, job views, webhooks and the dashboard. Legacy v1 links still work; unusable supplied links now fall back to a canonical v1 link instead of losing the Open link. Both v2 segments are bounded and validated before use.
- Malformed HTTP request targets now return `400` with `invalid_request` instead of causing an uncaught URL parsing error and an unauthenticated restart loop. The request log records only `(invalid)` and status 400, without the raw target. Valid request routing is unchanged.

## 0.2.1 (2026-10-22)

### Upgrading

- **Database migrations 16 and 17, forward only.** Migration 16 makes existing worker turn failures recoverable: jobs with `t3_run_failed` and a thread become `idle`, preserving their error and history. Migration 17 adds private storage for queued launch attachments. Older builds refuse the newer ledger. Stop older gateway processes and back up the data directory before the first start. Running any command against the data directory migrates it. **Rolling back to 0.2.0 requires restoring that backup**, losing anything recorded since the upgrade.
- Node requirements remain 24.22.1 or a later 24.x, or 26.12.1 or newer.

### Added

- **Send images and files to T3 jobs** ([#41](https://github.com/boundsj/t3-fleet-gateway/pull/41)). `work_start` and `work_continue` accept base64 attachments, uploaded to the authorized destination T3 host and delivered with the instruction through T3's native attachment APIs. Limits are 8 files, 5 MiB each and 10 MiB total, with MIME/filename allowlists and image signature checks; URLs are unsupported. Queued bytes stay separate from job views and are cleared after launch or cancellation. Provider/model support varies. Attachment follow-ups have no downstream retry key: uncertain sends stay blocked for that request ID across restarts to prevent duplicate turns. Inspect the thread before submitting new work. See [Sending images and files](docs/attachments.md) for storage, retention and retry details.

### Fixed

- **Keep worker turn failures recoverable** ([#40](https://github.com/boundsj/t3-fleet-gateway/pull/40)). A failed worker turn now leaves a launched job `idle` with `lastError.code: t3_run_failed`, so the watcher keeps following it and `work_continue` can resume it. Later activity clears the error and records `job_recovered`; dashboard attention, status, feed and settlement follow the same model. Failure webhooks keep type `failed` but report state `idle`. Launch failures, missing threads, cancellation and release remain terminal. Migration 16 reclassifies eligible old jobs without relaunching, resending or emitting a notification.

## 0.2.0 (2026-10-22)

### Upgrading

- **Node first.** This build needs Node 24.22.1 or a later 24.x, or Node 26.12.1 or newer. Upgrade Node on the gateway machine before you deploy it: on an older Node the launcher refuses to start, so the service stays down until Node is upgraded (see Security below).
- **Database migrations 14 and 15, forward only.** Migration 14 adds where each job came from (`origin`: `gateway`, `standing` or `adopted`, with the adopting client and time), per-client thread opt-ins, and append-only audit tables for scope changes and client thread actions. Migration 15 changes no data; it is a version barrier for paired host/project webhook targets. After either one, 0.1.x builds refuse the ledger. Stop older gateway processes and back up the data directory before the first start of 0.2.0. Running any command of this build against the data directory (`doctor`, `jobs list`, …) migrates it. **Rolling back to 0.1.x means restoring that backup**, and everything recorded since the upgrade is lost.
- **New thread scopes are off for every existing client.** `threads:read` (find and read threads opened directly in T3) and `threads:control` (adopt and control them) are never granted automatically, and the approval page does not offer them. An operator grants them per client: `t3-fleet-gateway clients grant <clientId> --scope threads:read --scope threads:control`, checks with `clients scopes <clientId>` and removes them with `clients ungrant <clientId> --scope …`. A change applies on the client's next request with its existing token: no new token, connector change or restart. Both scopes come on top of the client's host Read/Operate grant, never instead of it.
- **New background traffic.** `serve` now checks every enrolled host with a read-only `t3_environment_read` about 2–3 seconds after startup and then every 5 minutes (`reachability.intervalMinutes`, 1 to 60). Catalogs are still read only on demand.
- Everything else carries over: credentials, grants, tokens, jobs, webhook connections and their queues. Webhook connections need no re-registration.

### Security

- Node 24.22.1 or a later 24.x, or Node 26.12.1 or newer, is now required (`engines`: `^24.22.1 || >=26.12.1`). These releases ship [nodejs/node#66871](https://github.com/nodejs/node/pull/66871), which blocks the eight compromised eMudhra/emSign intermediate keys (CVE-2026-111943) inside Node's own TLS verification, for fetch/undici, HTTPS and TLS alike, with the bundled CA list and with `--use-system-ca`, and keeps every root. The launcher refuses to start on an older release (including 25.x and 26.0 to 26.12.0) with a message naming the minimums, and `deploy/launchd/install.sh` refuses to install with one. The gateway's own blocklist preload, added earlier in this cycle and never in a tagged release, is removed; `CERT_REVOKED` still counts as a webhook `tls_error`. CI runs on exactly 24.22.1 and 26.12.1. The opt-in live test (`test/tls-trust-live.test.ts`) now requires `CERT_REVOKED` from Node itself with nothing preloaded. See [docs/security.md](docs/security.md#compromised-emudhra-intermediates).

### Added

- **Find and adopt threads opened directly in T3.** `fleet_threads { host, projectId }` lists a project's T3 threads (title, state, last update, archive and settlement fields when T3 has them, and whether a gateway job already owns the thread), paged 50 at a time (up to 100), with a 30-second cache and the usual `catalog_limit` bound. `work_adopt { host, projectId, threadId, requestId }` turns one of them into a gateway job (`origin: adopted`) using only T3 reads; the existing status, feed, messages, continue, respond, settle and cancel tools then work on it. Adoption changes no model, runtime or workspace, holds no launch slot or folder reservation, and `jobs release <jobId>` ends it without touching T3. Threads the gateway already owns, standing jobs, archived threads and delegated child threads cannot be adopted. Both tools need discovery enabled on the host and the client's host grant, plus `threads:read` (and `threads:control` to adopt or control). Clients without `threads:read` do not see adopted jobs anywhere. Standing jobs keep working with host grants alone. The dashboard marks adopted jobs.
- **`clients grant`, `clients ungrant` and `clients scopes`** turn the thread scopes on and off for one client and show its current ones. They are idempotent, audited (ids, action and time only), check every scope name before writing and refuse unknown clients.
- **`work_settle({ jobId, requestId })`** lets clients with Operate access settle idle, cancelled, failed or released jobs after a fresh T3 status and delegated-work check. It uses the existing host credential, maps permission and busy refusals to typed errors, confirms settlement by reading it back and emits a `thread_settled` feed event. Durable request-id replay never re-sends settlement after an ambiguous outcome. `work_status` shows live `settled` / `settledAt` (null when unknown); `work_continue` on a settled idle job resumes it through T3.
- **Settle from the dashboard.** Quiet jobs with a T3 thread get **Settle** (then **Confirm settle** or **Keep open**) on Overview attention cards and in Jobs. It goes through the same settlement as `work_settle`, clears the job's attention item and adds a **settled** badge while the job keeps its state and history; new activity on the job brings the attention back. It uses the dashboard's existing write guards (custom API header, exact Origin, fetch metadata, bounded JSON).
- **Host problem cards on the dashboard.** A host can answer health checks while its model catalog or other calls fail. The dashboard now records catalog fetch failures, failed T3 calls, `work_start` resolution failures and dispatch failures per host (in memory, codes and fixed text only), shows them as Overview attention cards with first and last time and a count, and shows the last model-catalog result on Hosts. Each kind clears on the next success of the same kind, and stops raising attention after 24 hours without recurring.
- **Background reachability checks**, described under Upgrading. Every T3 call that succeeds, or fails on transport or authentication, now also updates the host's reachability and its time.
- **Webhook targets on any host.** The dashboard's webhook setup lists discovered projects from every enrolled host with discovery enabled, grouped by host, beside the configured aliases; a host that cannot be read is marked and the rest stay usable. Such a connection stores the exact host and project id pair, and matches alias jobs and `target: { host, projectId }` jobs for that pair only, never the same project id on another host. Configuration-managed subscriptions can use paired `targets` too.
- **A privacy check for this public repository.** `npm run privacy:check`, now the last step of `npm run check`, scans tracked and new files for real-looking `*.ts.net` hosts, home-directory paths, private and tailnet IPs and credentials, and for the maintainer's own private list (`PRIVACY_DENYLIST`, or the gitignored `.privacy-denylist`). It prints only locations and categories, never the text that matched. `--file`, `--stdin` and `--commits <range>` scan release or PR text and commit messages. `.github/workflows/privacy.yml` re-checks a pull request's title, description and commits when they change, `.github/pull_request_template.md` adds a checklist, and `.githooks/pre-push` is an optional local guard. AGENTS.md "Privacy and publishing" lists what must never appear and the placeholders to use instead.

### Changed

- The webhook payload `link` is now built by the same code as every other thread link. Plain UUID and `mcp:<uuid>` thread ids give the same bytes as before; ids with literal percent signs or URI punctuation are now escaped, and an id the gateway cannot turn into a safe link gives `link: null`. `threadId` is unchanged.
- `clients revoke` refuses `--scope` and points to `clients ungrant`; revoking a whole client works as before.
- Docs, evidence and screenshots use generic host names and leave out deployment-specific details.

### Fixed

- `fleet_models` and an explicit `work_start` `modelSelection` failed on T3 builds that return compact model options (`{ id, values, default? }`). Compact string values are now read as choices and boolean values as toggles, full descriptors still work, and a malformed model or option is skipped on its own instead of failing the whole catalog.
- `fleet_threads` and `work_adopt` refused valid T3 thread ids that contain colons or percent escapes (such as `mcp:<uuid>`), so a refresh kept failing. Such ids are now accepted and linked correctly. A thread that shows up twice because T3's offset pages moved underneath the scan is listed once, and malformed rows are skipped with a count-only warning.
- After a gateway restart the dashboard could show a host as **Not checked** even though calls to it were succeeding.
- The webhook setup offered only configured aliases, so projects on other enrolled hosts could not be chosen.

## 0.1.14 (2026-10-20)

### Fixed

- A merged pull request could raise no `pull_request_merged` event, and later polls never reported it. 0.1.13 kept at most 20 PRs per job and treated a snapshot of 20 as a window. A PR that opened and merged between two polls could not outrank a window of open PRs and was ignored, and a followed PR that merged on a thread with 21 or more open PRs was cut from the snapshot before it was compared. A job now follows up to 200 PRs (beyond that, open ones first, then the newest) and compares the lists in full: a PR whose state became open or merged raises its event, and so does a PR the previous list did not hold. Only a list at the 200-PR bound is treated as a window, where a PR that merely re-enters because another left still raises nothing.
- Everything shown or sent still carries at most 20 PRs, open ones first and then the newest, listed in that order: `work_status`, `work_list`, `work_feed` and the other job views, their text summaries, PR webhook payloads (which stay inside the 16 KiB bound for ordinary links, however many PRs the job follows) and the dashboard. When a job follows more, the text says `20 of 35 shown` (`20 of 200+ shown` at the bound), and the PR an event is about may not be among those shown.
- A PR URL must have the lowercase `/pull/` segment and a number without leading zeros. 0.1.13 compared the whole path without regard to case and accepted `https://github.com/owner/repo/PULL/23`, which GitHub answers with 404. Owner, repository and host are still compared without regard to case, and the URL is stored and shown exactly as T3 gave it.

### Compatibility

- No migration, configuration or tool-shape change. `jobs.pull_requests` is the same column and now holds up to 200 PRs (about 26 KB for 200 typical links); the job views keep their fields and their 20-PR bound. Rolling back to 0.1.13 reads a longer stored list back as its 20-PR window.
- Snapshots stored by 0.1.13 held at most 20 PRs. On the first read after the upgrade, a thread that links more than 20 PRs shows its extra PRs as new to the job, so that job may raise one `pull_request_opened` and one `pull_request_merged` once. Threads with 20 or fewer PRs raise nothing.
- Known limit: a job whose list holds exactly 200 PRs is treated as having more, so a PR that opens and merges between two polls while older PRs are unlinked can go unreported there ([design](docs/design.md#job-pull-request-snapshots)).

## 0.1.13 (2026-10-20)

### Fixed

- Job pull requests were missing for repositories with capital letters and for threads that linked more than 20 PRs, with nothing logged. T3 lists `repository` in lower case while the PR URL keeps GitHub's casing, so the URL check rejected every PR of such a repository, and one rejected entry (or a 21st) discarded the whole list, leaving the job without a snapshot or frozen at its last one. The URL's path and host are now matched without regard to case, and the URL is stored and shown exactly as T3 gave it; every other check (https only, matching host, no port, credentials, query or fragment) is unchanged. T3's list is read entry by entry: an invalid entry is skipped, a repeat of a PR counts once, a list with entries but none valid is unknown (the last snapshot stays), and an empty list is none. The `list_thread_pull_requests` call itself no longer fails on a long list or an odd entry.
- A snapshot holds at most 20 PRs: every open PR first, then the newest (highest number). `work_status` and `work_list` say so when they show 20 and older ones may be left out. A PR that leaves or re-enters a full snapshot raises no `pull_request_opened` or `pull_request_merged` event by itself.

### Compatibility

- No migration, configuration or tool-shape change, and stored snapshots read back unchanged. Jobs whose snapshot was never readable and is still unknown (existing and adopted jobs) get a silent baseline on their first good read; a job launched on 0.1.12 whose lists were always rejected still holds its initial empty snapshot and reports its PRs once then (at most one `pull_request_opened` and one `pull_request_merged`).

## 0.1.12 (2026-10-20)

- Follow T3-linked pull requests through cached `work_status`/`work_list` responses, with links, states and freshness for text-only clients.
- Show PR number/state badges on dashboard jobs.
- Add opt-in PR opened/merged feed and webhook events, atomically captured with snapshots and preserved across restart. Existing webhook defaults stay unchanged.
- Keep optional PR lookup failures separate from host health; bound reads and retain last good data. Migration 13 adds nullable PR cache columns. No live hosted-client qualification is claimed.


## 0.1.11 (2026-10-20)

### Added

- Optional automatic workspace selection for named projects, per host: `hosts[].workspaceProbeCommand` is an exact argv (no shell) that inspects a project's folder, given one JSON object on stdin ([Workspace probe](docs/configuration.md#workspace-probe), reference script `scripts/workspace-probe.js`). On such a host a repository root gets a fresh worktree from the freshly fetched remote base (`startFromOrigin: true`, on the alias's or discovery policy's `baseRef`), and any other folder runs in the folder itself (T3's `root` strategy, no branch). `work_start` takes an optional `workspace` (`{ "type": "auto" }`, `{ "type": "root" }`, `{ "type": "worktree", "baseRef"?, "startFromOrigin"? }`); on a host without a probe, or for a scratch alias, it is refused with `invalid_argument` and nothing is created. The choice is made when the job launches: acceptance reads nothing from T3 or the host, so alias-only starts keep their request-id hash and queue while the host is down. Contributor work from PR 16, reworked.
- Root reservations: jobs in a project's own folder (`workspaceMode: "root"`) are serialized per host and identical canonical folder path, whatever aliases or T3 projects name that path. Nested paths (a repository root and a subdirectory of it) are not related. The ledger holds the reservation (migration 12, partial unique index), so it survives restarts and races between dispatch, `work_continue` and `work_respond`. It is held while the job is `dispatching`, `running`, `needs_input`, `cancel_requested` or `unknown` and while an idle coordinator's delegated work still runs; released when the job is idle with nothing delegated, or finished, once no unresolved resume attempt remains. Waiting jobs stay `queued` with `lastError.code` `workspace_root_busy` and take neither a slot nor the places of jobs behind them; resuming an idle job while another holds the folder is `workspace_root_busy` and sends nothing. Each follow-up or answer to an idle root job is an attempt with its own ledger-held ownership token, and every attempt restarts the ten-minute grace period: a definite failure gives back only its own claim (the folder is freed when no attempt is in flight and none ended unknown), a successful call settles only its own deduplicated operation, and an unknown outcome keeps its token across restarts until that operation resolves or the grace period ends at rest. State changes never settle sibling calls still awaiting an answer. Work started in T3 itself and standing jobs are outside it (recorded as a `workspace_root_contended` event); it is not a global lock.
- `workspaceMode: "root"` in job views, `choosesWorkspace` on `fleet_status` hosts, a root and a `startFromOrigin` sample in the compatibility check.
- Version 3 launch specs, and migration 12: the workspace, root reservation, resume attempt token and probe retry columns on `jobs`. Migration 12 is also the schema-version barrier for version 3 specs: older builds refuse the ledger. Stop older processes and back up the data directory before the first start of this build.

### Fixed

- A probe that fails, times out or returns bad output fails or delays only its own job. Jobs behind it dispatch in the same tick (also with one free slot); a probe that cannot reach its host (timeout, exit 255) gets three attempts for that job; a T3 host failure still backs the host off. Stopping the gateway kills a running probe.

### Compatibility

- Existing configurations are valid unchanged. Without `workspaceProbeCommand` nothing changes: worktrees from the local `baseRef`, legacy request-id hashes, no downstream call before dispatch. Queued jobs with version 1 or 2 specs keep their meaning on any host.
- Covered by `test/workspace.test.ts` (public MCP and engine, synthetic probe, a reference-script check with real Git), a populated 11 to 12 migration in `test/storage.test.ts` and a config case. The field `workspaceRoot` in T3's project list is not confirmed against a live T3, and no live root launch is claimed.

## 0.1.10 (2026-10-20)

### Added

- Work with no named project, per machine. A host can name a scratch alias as its `defaultProject`; `work_start` with `target: { host }` then starts the job in that alias, in T3's internal scratch workspace (shown as "No project" in T3) with no git worktree or branch. The host needs no discovery for this (an explicit `projectId` and a model selection do); `discovery.allowWorkStart` still governs only T3 projects without an alias. Agents are told to use a host-only target when the user names no project, and never to fall back to scratch for a named project they cannot resolve. [Configuration](docs/configuration.md#no-named-project).
- `projects[].workspaceMode`: `worktree` (the default, unchanged) or `scratch`. A scratch launch sends `t3_thread_launch` with `scratch: true` and neither a project id nor a workspace strategy, so T3 files the thread under its own scratch project and gives it a folder of its own. The alias needs an explicit `t3ProjectId` pin, which must be that scratch project's id: the gateway validates it against the host's projects before each launch and looks there for a launch whose response was lost, but cannot check what the project is. If T3 files a thread under another project than the pin, the job follows the thread and the gateway logs the fixed warning `job.scratch_project_mismatch` (job and host ids only). A scratch pin may not be shared with a worktree alias on the same host (`config_invalid`). A scratch alias keeps every rule of an alias (`allowWorkStart`, `runtimeMode`, model defaults, per-host grants). Naming it with `project`, or using the host-only target, works without discovery and is recorded from the configuration without reading T3, so the job queues while the host is down and no T3 project name is recorded (`projectName` is null). An explicit model selection (validated against the fresh catalog at creation and at dispatch) and an explicit `projectId` need discovery; a target that names the pinned project is launched as that alias, scratch included.
- `workspaceMode` in job views (null for an adopted standing thread), `fleet_status` projects and `fleet_projects`; `defaultProject` in `fleet_status` hosts. A scratch job's `branch` is empty, and its launch footer says it runs in T3's internal scratch workspace.
- A scratch launch records a version 2 launch spec (scratch only): host, pin, alias, runtime mode and model, and the host-default binding when the default chose the alias. The dispatcher reads the host's projects and checks it again right before launching, and fails the job without launching if the alias, its pinned project, workspace mode, runtime mode or `allowWorkStart`, the host's default, or the host's `access` ceiling changed while it was queued (`launch_policy_changed`; `project_not_configured` when the alias was removed, `project_not_found` when the T3 project is gone). Version 1 specs keep their meaning, and a scratch job's lost launch response stays `unknown` and reconciles on the recorded project.
- The developer compatibility check (`npm run compat:check`) also validates a launch with `scratch: true`, the input a scratch alias sends, against T3's advertised `t3_thread_launch` schema.
- Migration 11, a schema-version barrier that changes no data and no table, numbered after the webhook migrations 9 and 10. It makes builds that do not know version 2 launch specs refuse the ledger, instead of reading a scratch spec as none and launching it in a worktree.

### Fixed

- A stored launch spec this build cannot read (damaged, or written by a build that knows more) used to be read as no spec, so its job was dispatched as an alias job from the configuration: a scratch job, or one started with a model selection, as a plain worktree job. It is now flagged on the job (`launchSpecUnreadable`) and never launched, and no read fails with it, so one bad row cannot stop the dispatcher, the watcher, `work_list` or the dashboard for its host. A queued job in that state fails with `database_error` and the message "This job's stored launch plan could not be read. Start the work again." through a normal guarded transition (it is in the feed, and in matching webhooks), and the jobs behind it still dispatch in the same tick. A job that already has a thread is followed as usual. Job views leave out what only the spec said: `projectName` and `model` are null, and `workspaceMode` is null (unknown, not a worktree). The first read of such a job in a process logs `job.launch_spec_unreadable` with ids only.
- Stored jobs are read with the caller's host scope applied in SQL, so a job on a host the caller cannot read is reported exactly as an unknown job, whatever its launch spec holds. A repeated `work_start` request id is authorized against the stored job's host and answered from the ledger before the current alias is resolved: a replay survives the alias being renamed, moved or removed and asks T3 nothing; a replay without Operate on the job's host is `insufficient_scope`, with or without changed input, and the same check runs again inside the creation transaction.

### Compatibility

- Existing configurations are valid unchanged: aliases default to `workspaceMode: "worktree"`, and `defaultProject` is unset. Existing worktree aliases keep their request-id hashes and their downstream-free queueing, and so do scratch aliases and the host-only target.
- Upgrading moves the ledger from schema version 10 to 11. Stop older processes first and back up the data directory: a build that stops at version 10 refuses the new ledger, so going back means restoring the backup. Running any command of the new build against the live data directory migrates it.
- Covered by synthetic tests: `test/projectless.test.ts` (launch shape, a host that is down, replays, policy drift, authorization order, lost responses, restarts, configuration), scratch cases in `test/host-scopes.test.ts`, `test/webhooks.test.ts`, `test/dashboard.test.ts`, `test/fleet-status.test.ts` and `test/discovery.test.ts`, and a populated version 10 to 11 migration in `test/storage.test.ts`. No live T3 run of a scratch launch is claimed.

## 0.1.9 (2026-10-17)

### Added

- **Connect Grok Bot** in the private dashboard: paste a webhook URL and its full authentication header, choose a configured project, and select **Connect & Test**. Generic HTTPS receivers work too. A successful test means the receiver accepted the request; check the bot conversation to confirm its response. Connections send `idle`, `needs_input`, `failed`, `cancelled` and `delegated_work_ended`, with worker excerpts off.
- A **Webhooks** view lists project, host, management source and safe last-test information. Dashboard connections support **Send test**, **Replace key** (including a replacement URL), and confirmed **Disconnect**, without editing files or restarting. Saved destinations and authentication values are never returned to the browser.
- Migration 10 adds explicit config/dashboard ownership and safe last-test metadata. Existing subscriptions remain config-owned. Dashboard connections and their queues survive restarts independently of config reconciliation; the CLI can list attempts and ping either source.
- `dashboard:demo -- --webhook-receiver` provides a local synthetic receiver for accepted, rejected and timed-out setup tests. Demo management refuses destinations outside literal loopback.
- Opt-in outbound job webhooks with private per-subscription auth headers, project/host/event filters, metadata-only default payloads, bounded optional excerpts, durable atomic snapshots and deliveries, stable event IDs, restart recovery, bounded HTTPS attempts and retries, and safe CLI diagnostics/test ping. Existing feed cursor behavior and polling fallback remain unchanged. Migration 9 adds outbox/attempt tables and durable exact-run gateway attribution; unknown turn origins remain unknown.
- Watcher same-state events (`turn_finished`, `delegated_work_ended`) commit atomically with their observed job changes. Whole turns between polls generate an idle webhook. Config revisions cancel queued payloads for replaced routes; read-only commands never apply stale config.

### Documentation

- Shorter, prompt-led README with a Grok routine walkthrough, private field-link instructions and an illustrated setup guide. Manual installation and connection commands moved to `docs/setup.md`; release history stays in the changelog and GitHub releases.

### Security and lifecycle

- The dashboard's private network boundary now permits webhook destination management. It remains separate from the MCP/OAuth listener; job, host and client controls are unchanged. Management requests require JSON, the custom API header, an exact request-host Origin and same-origin fetch metadata when present. Errors and audit records contain fixed codes only; no saved URL, header, response body or credential is exposed, and the browser stores no secrets.
- Connection creation and replacement use the same bounded TLS-validating POST transport as delivery. A failed test preserves the existing route. Successful changes recheck the revision after the awaited test and cancel pending old-route payloads; disconnect cannot be undone by a slow test. Writes are refused before readiness and after shutdown begins; shutdown aborts and drains management pings before closing SQLite.
- No live Grok receiver or deployment qualification is claimed by this implementation's synthetic tests.

## 0.1.8 (2026-10-16)

### Added

- An opt-in, read-only operator dashboard (`dashboard`, off by default; [operations](docs/operations.md#operator-dashboard), [design](docs/design.md#operator-dashboard), [security](docs/security.md#the-operator-dashboard)). `serve` runs it on a loopback listener of its own (default `127.0.0.1:3791`, never the MCP port), to be published with a tailnet-only proxy on a path (`dashboard.basePath`). Views: an overview (what needs you, vital signs, an agents → gateway → hosts map, recent activity), hosts (last check with its time, engine backoff, credential and renewal, capacity, policy and projects), clients (authorization separated from observed MCP and refresh successes; unknown stays unknown), jobs (waiting or recent, open, finished, with T3 thread links and a code-only activity log) and checks. It controls nothing: approvals and job control stay in T3.
- **Run checks**, on demand only: a fresh `t3_environment_read` per host, the public URL's metadata, that the public URL does not serve the dashboard, the database quick check, data directory permissions, credential state and the mint executable's resolution. Nothing is enrolled, renewed or executed.
- `doctor`, with the dashboard enabled, checks that it answers on its listener and that the public URL does not serve it (`dashboard exposure`).
- `hosts[].transportNote` (a descriptive label such as "SSH tunnel", shown on the dashboard and never checked) and `dashboard.clientLabels` (display names for client ids).
- `npm run dashboard:demo`: the dashboard on a synthetic fleet (a real gateway with temporary data, fake T3 hosts on loopback, the fictional clients Grok Bot, Muse and Notion) in five scenarios, for screenshots and browser checks.

### Security

- No login, session, cookie or browser storage: the network (loopback plus a tailnet-only proxy) is the boundary, and the page holds no secret. Requests with an unexpected `Host` get `421` (DNS rebinding); requests Tailscale marks as Funnel traffic get `403`; API requests need a custom header and refuse cross-site fetch metadata and foreign origins; responses carry a strict CSP without inline script or style, `frame-ancestors 'none'` and CORP. The page builds its DOM without HTML parsing and links only to its own views and `t3-thread://v1/<id>` (built from validated thread ids).
- The dashboard shows no tokens, hashes, codes, T3 credentials, the server key, mint commands or their output, task text, replies, questions, options, answers, delegated task titles or catalogs, and errors only as codes with fixed text. Opening it never contacts T3.

### Compatibility

- No migration and no change to OAuth, MCP, tools, grants or the job engine's behavior. The engine and host registry gain read-only accessors (`JobEngine.status()`, `HostRegistry.lastHealth()`), the job store two read queries, and `doctor`'s public URL check shares its probe with the dashboard. Existing configs are valid unchanged.
- Covered by synthetic tests: `test/dashboard.test.ts` (configuration, listener isolation both ways, Host/Funnel/Origin/fetch-metadata/content-type handling, headers, base paths, honest host states including outage, refusal, not enrolled and engine backoff, clients with expired, revoked, replayed and never-observed grants, jobs and attention, privacy of content and secrets in responses and logs, bounds, read-only checks, exposure through a misdirected tunnel), `test/dashboard-ui.test.ts` (hostile text in every view, unsafe links dropped, no HTML-parsing APIs) and `test/dashboard-demo.test.ts` (four demo scenarios end to end). No live deployment is claimed here.

## 0.1.7 (2026-10-16)

### Fixed

- The configured non-mutating `mintPairingCodeProbe` has a ten-second deadline instead of two. A macOS service run as a launchd agent with `ProcessType` Background has its children scheduled at a lower priority: the configured T3 version probe, which answers in well under a second in the foreground, took over two seconds there on a test machine, so startup logged `probe_timeout` while foreground `doctor` passed ([evidence](docs/evidence/startup-probe.md)). Output budgets, the exact configured argv, executable resolution, startup independence, abort on shutdown and the non-mutating-only rule are unchanged; a hung probe can now hold the first renewal pass or a `doctor` host check for up to ten seconds. No launchd template or configuration change.

### Added

- Opt-in discovery of T3 projects and model capabilities per host (`hosts[].discovery`, all off by default; [issue #12](https://github.com/boundsj/t3-fleet-gateway/issues/12)). With `enabled`, agents with Read access on the host get two read-only tools: `fleet_projects` (T3 project ids and names, with the launch policy that applies to each and how to start work there) and `fleet_models` (provider instances, models and their advertised options such as a reasoning effort, including providers with no models, with T3's child-task flags and constraints as metadata). Catalogs are read from T3 on demand, kept for 30 seconds, shared between concurrent readers, refreshed with `refresh: true`, paged per host with cursors bound to one read by a random snapshot id (an old cursor is refused after a refresh, the TTL or a restart), and bounded (2,000 projects; 100 providers, 2,000 models, 64 options per model, 256 choices per option): a catalog beyond a bound is reported unavailable, never cut. Unavailable or disabled hosts never hide the others. Text output carries every id and choice for clients that read only text.
- `work_start` accepts, besides a configured `project` alias, a `target: { host, projectId }` from `fleet_projects` and an optional `modelSelection: { instanceId, model, options? }` from `fleet_models`. A target that exactly one configured alias maps to is launched as that alias with all of its settings (`allowWorkStart: false` still refuses); several matching aliases or an ambiguous title mapping require the alias; a project with no alias follows the host's discovery policy (`runtimeMode`, `baseRef`, `branchPrefix`) and needs `discovery.allowWorkStart`. The project list is read from the host at that moment, never from the browse cache, so a project renamed after an agent browsed is classified under its current title, and the policy is checked again right before the launch (`launch_policy_changed` fails a queued job whose project has since been renamed into a configured title or lost its launch permission). An explicit selection must match the host's freshly read catalog exactly (`false` is preserved for boolean options) and is checked again right before the launch; otherwise it is refused and nothing is started or substituted. `target` and `modelSelection` are strict objects: an unknown field such as `reasoningEffort` outside `options` is refused with no job, never dropped. Omitting it keeps the whole configured default (project, then host, then the T3 project default). What such a job resolved to is recorded with it (`jobs.launch_spec`, append-only migration 8); alias-only jobs dispatch exactly as before and their request-id hashes are unchanged.
- Job views add `projectId`, `projectName`, `source` and `model`; feed events add `host` and `projectId`; `work_list` filters by `target`; `fleet_status` hosts show their `discovery` flags. New error codes `discovery_disabled` and `catalog_limit`; the dispatcher's `model_selection_invalid` and `launch_policy_changed` failures.
- The developer compatibility check now covers `orchestrator_capabilities` (twelve consumed tools).

### Compatibility

- No change for existing configurations: discovery is off unless `hosts[].discovery.enabled` is set, and the host must separately set `discovery.allowWorkStart` before any launch into an unconfigured project. Existing grants, aliases, defaults, request ids and queued jobs behave as before. Migration 8 adds one nullable column.
- Covered by synthetic two-host tests (`test/discovery.test.ts`): opt-out, same-named projects on two hosts, restricted and read-only grants, an unavailable host, browse-only hosts, alias bypass attempts, selections and defaults, idempotency, restart, pre-dispatch failures, lost launches, paging, cache, cursor identity across a restart, strict selection input, title renames after browsing and privacy. A bounded isolated smoke against one fresh QA-only T3 instance passed 28 of 28 checks at both the initial head and the implementation with review fixes ([docs/evidence/discovery.md](docs/evidence/discovery.md)). That is not a live fleet or hosted-connector (Grok, Notion) qualification.

## 0.1.6 (2026-10-15)

### Fixed

- T3 thread responses no longer have to include `link`. Current launch, list and read responses are normalized to the documented `t3-thread://v1/<threadId>` URL without encoding the opaque id. Older supplied links and existing job links remain supported. This restores watcher reads, launch reconciliation, standing-job adoption and message reads against current T3, without relaxing other required response fields or retrying launches.
- A valid watcher observation clears a previous `t3_invalid_response` error, so recovered jobs no longer retain the stale schema failure. Genuine run failures keep their existing clearing rules.

No database migration or configuration change.

## 0.1.5 (2026-10-13)

### Added

- Per-machine authorization. The approval page offers All machines (the fleet scopes: every host, including hosts added later) or Selected machines (`host:<id>:read` / `host:<id>:operate` for the ticked hosts only), and `clients token --hosts main,studio` (or `--hosts all`, the default) does the same for bearer tokens. Every tool enforces the hosts: `fleet_status`, `work_list`, `work_feed` events and attention show only permitted hosts (filtered before limits); direct job tools answer a job elsewhere as an unknown id, and `work_start` checks both the project's host and the host of a replayed request's job. Empty, malformed or unknown selections are refused before an approval code is spent or a token is stored. A refused approval page, including after a wrong approval code, is shown again with the machines and access the operator chose, never the request's defaults.
- `clients list` and `clients diagnose` show granted access per host.

### Compatibility

- No schema migration. Grants, refresh tokens and bearer tokens issued before 0.1.5 keep their fleet-wide access, including hosts added later, with no reauthorization. Metadata still advertises only the fleet scopes. Refresh can keep or narrow a restricted grant, never widen it; a refresh that asks for the generic fleet scopes keeps the grant's own hosts.
- `clients list` shows fleet-wide access as `operate (all hosts)` / `read (all hosts)`, and `clients token` names the hosts it covers.

Covered by synthetic two-host tests through the public OAuth, MCP and CLI interfaces. No live multi-host qualification is claimed.

## 0.1.4 (2026-10-12)

### Fixed

- Found in live testing: accept T3-owned opaque pending request IDs unchanged in `work_respond` and targeted `work_status`. Real Codex IDs exceed the previous 200-character limit. Job/request membership, non-empty validation and the separate question-id, answer-size and idempotency-key limits remain enforced. Public text-only regressions reproduce both failures before the fix; the original real question resumes successfully after it.

- A transient T3 `waiting` status with zero pending requests no longer invents a permission approval. Actual questions and positive pending counts still produce `needs_input`. The native sample predates this state-rule fix; its synthetic regression fails before the fix and passes after it, and real v0.1.4 question resumption after the fix showed no false approval. Operator permission-approval retests completed afterward, with exact scratch markers and cleared approval flags.

### Changed

- Restore the prepared expanded opt-in lifecycle script: tool discovery, `work_list`, full `work_messages` reads and explicit successful-tool coverage. An explicit scratch project alias is required.
- Document the verified behavior from live testing (lifecycle, isolated runtime failure, standing-job reuse, delegated child/parent resumption, SDK outage recovery and a lost start response) in docs/operations.md, "Verified behavior". v0.1.4 question, lifecycle and permission-approval retests passed; a direct HTTP client using only content text passed the isolated question/messages/feed check, and Grok Bot read a real question and its options as plain text and answered with the full request ID (over 200 characters). A separate Notion job workflow and hosted-client recovery remain unrun.

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/) once it reaches 1.0.

## 0.1.3 (2026-10-12)

### Added

- Offline `clients diagnose <id>` reports OAuth versus static bearer clients, usable access/refresh grants, expiry ranges, rotation/grace/supersession/replay states, and each family's revocation reason. Aggregate usability considers every family, while explicitly leaving operator/cloud route reachability and the connector's saved token unknown.
- Separate successful MCP and refresh timestamps (append-only migration 7). Old mixed last-use data remains intact; new times start unknown. Completed authorized MCP HTTP 2xx exchanges are sampled once per minute; successful refresh pair issuance, including grace retries, is recorded transactionally on every success.
- Synthetic SDK outage recovery regression: saved credentials and feed cursor survive ingress loss across access expiry, automatically refresh on reconnection, and resume without duplicate events or work. This recovery already passed on the pinned v0.1.2 implementation; the new diagnostic CLI was missing there.
- Recovery instructions distinguish ingress, gateway authentication, downstream T3 credentials, and disabled connector routines. Installed SDK retry limits are documented; real Grok and Notion retry behavior remains unverified.

### Changed

- `clients list` labels OAuth families as `unrevoked` rather than inferring active authentication from their count; use `diagnose` for grant usability.

No new live verification, deployment, or publishing is claimed.

## 0.1.2 (2026-10-12)

### Fixed

- `work_status` text now includes pending request and question ids, headers, question text, every option label/description/value, selection rules and answer constraints. Clients that consume only MCP text can answer with `work_respond`. `allowCustomAnswer`, `required` and `multiSelect` preserve true/false, with null for null or absent T3 flags. Unreadable questions remain explicitly temporarily unreadable.
- Pending questions are bounded without partial actionable data: at most five requests read by default; `pendingRequestId` selects another. A request exceeding 50 questions, 100 options per question or 64,000 JSON characters returns `questions: null` and `questionsUnavailable: "too_large"`, directing the operator to T3. `read_limit` and `temporarily_unreadable` explain other null results. `work_cancel` text points to `work_status` before answering a still-pending question.
- Unspecified question flags retain honest nulls while text provides an answer path: follow explicit wording, and without instructions to select several try a single listed value as a conservative attempt. T3 validation remains authoritative; omitted/null flags alone do not require escalation.
- Automatic renewal starts after all startup preflight checks settle, including an unexpected rejection, unless shutdown has begun. Rejections produce fixed diagnostics; logger errors still propagate and known executable failures still gate each host's renewal.
- Probe cancellation explicitly force-kills the direct child, including probes that ignore SIGTERM on Node 26.0. Startup preflight never initiates or awaits health reads, so stalled MCP initialization cannot delay shutdown through preflight; doctor still compares fresh health.
- `doctor` and `serve` startup preflight the mint executable in their own process environment, diagnose missing/non-executable commands and version-pinned paths, and distinguish known failure from unverified checks. Known executable failures stop automatic renewal before pairing registration while retaining the old credential.

### Added

- Optional `hosts[].mintPairingCodeProbe`: exact argv for an explicitly operator-configured non-mutating probe. No mint command or guessed `--version` is executed as preflight. Probes time out after two seconds, cap stdout/stderr at 4,096 bytes each, and are aborted on shutdown without being awaited. A bare version, exact native `t3 v<semver>` output or JSON `{"version":"x.y.z"}` enables comparison with the T3 server; disagreement is a warning, not an incompatibility verdict.
- Synthetic public MCP and CLI regressions, question-limit/nullable-flag coverage, PATH/probe/startup/shutdown checks and logging/event leakage checks. Command diagnostics contain no raw stdout/stderr, argv or executable paths; enrollment no longer echoes command argv.

No database migration. No new live QA is claimed.

## 0.1.1 (2026-10-09)

### Added

- `deploy/launchd/install.sh` warns when `T3_BIN` (by default `command -v t3`) is inside one T3 version's directory (`.../runtime/versions/<version>/`). After T3 updates itself, a service `PATH` holding that directory keeps running the old `t3` for credential renewal, and renewal fails with `pairing_command_failed` if the directory is removed.
- docs/operations.md, "A t3 that follows T3's updates": why, and a wrapper that runs the version T3's service uses. The README's Setup section and the systemd unit point to it.

## 0.1.0 (2026-10-08)

### Added

- Agent-facing MCP server on `/mcp` (Streamable HTTP, stateless, JSON responses) that serves both 2025-era and 2026-07-28 clients and accepts requests without `MCP-Protocol-Version`.
- OAuth 2.1 authorization server: metadata, dynamic registration for public clients, an approval page gated by one-time codes minted with `pair` (Read or Operate), PKCE S256, rotating refresh tokens with replay detection and a retry grace window, idle expiry, and per-client revocation.
- Downstream T3 Code client per host, with enrollment through T3's pairing-code approval, verified credential storage, and automatic renewal before the 30-day expiry.
- `fleet_status` tool.
- CLI: `serve`, `pair`, `clients list|revoke`, `hosts enroll|status`, `jobs adopt|list|release`, `doctor`.
- SQLite storage with versioned migrations, including the tables for the job layer.
- launchd installer and systemd user unit.
- Job layer: `work_start`, `work_continue`, `work_respond`, `work_cancel`, `work_status`, `work_list` and `work_feed`. Jobs run as T3 threads titled `[job:<id>]` in fresh worktrees on `<branchPrefix><id>`, with a durable ledger and append-only event feed, request-id idempotency, a per-host FIFO dispatcher that respects `maxConcurrentJobs`, a watcher that derives `running`, `needs_input`, `idle` and `failed` from T3 thread reads, host backoff that never changes job state (a slow launch makes only that job `unknown`; a T3 error about one job is recorded on that job and never stalls the others), reconciliation of launches whose outcome was lost or that T3 answered with an error that may leave a thread (by the title marker at the end of the title, in unsettled and settled threads, never relaunched; `launch_not_confirmed` after `watcher.reconcileWindowMinutes`), and cancels that keep interrupting each run that starts on the thread until it stops (one T3 `clientRequestId` per run). A found thread on which no run ever started fails the job with `launch_not_started` (keeping the thread's id and link) instead of reporting a finished turn; any failed lookup after a launch error leaves the job `unknown`; a search match T3 refuses to read is skipped.
- T3 client wrappers for the thread and pending-request tools, and transport errors that say whether T3 may have received the call (`T3TransportError.delivery`; new error code `t3_response_lost`).
- Every job view carries `stateChangedAt` (when the job entered its current state; the feed's attention window and order use it) and `updatedAt` (the last real change, including the host-unreachable mark, not the last poll).
- Every job view carries `link`, which opens the job's thread in the T3 app, from the launch result on.
- Error codes `job_state_conflict` and `request_id_conflict`.
- Config: `watcher.reconcileWindowMinutes`; `hosts[].defaultModelSelection`, the model for projects on that host that set no `modelSelection` (T3 refuses launches without a model when the T3 project has no default). `doctor` fails a project that would have no model, `serve` logs `project.model_missing` at startup (in the background: shutdown does not wait for it, and a host that fails is not asked again for its other projects), and `fleet_status` shows each project's `runtimeMode` and `modelConfigured`.
- `config.example.json` enrolls its host with `access: "full-access"`: the host's access is only a ceiling, and each project's `runtimeMode` (default `approval-required`) is what limits a job.
- `scripts/e2e-live.ts`: a live end-to-end check against a running gateway and a real T3 host (`npm run e2e:live`), outside the test suite. If the job it cancels has already finished, it starts one replacement and cancels that.
- Standing jobs: `t3-fleet-gateway jobs adopt <project> <threadId> [--title <text>]` registers an existing T3 thread (for example a long-running coordinator thread) as a job agents drive with `work_continue`, `work_respond`, `work_feed` and `work_status`. The thread must belong to the project's T3 project; its state is read at adoption and its history is not replayed. Standing jobs hold no concurrency slot, a failed run leaves them `idle`, `work_cancel` interrupts their current turn only (new outcomes `interrupt_requested` and `not_running`; new event `interrupt_requested`), and `jobs release <jobId>` ends one in the new terminal state `released` without touching T3. Every job view has `standing`.
- Config: `projects[].allowWorkStart` (default `true`). When `false`, `work_start` in the project fails with the new error code `start_disabled`, whose message names the project's standing jobs and says to use `work_continue`. `fleet_status` shows each project's `allowWorkStart` and its open `standingJobs` (job id, title, state, link), and the `fleet_status`, `work_start` and `work_continue` descriptions tell agents to drive a project's coordinator with `work_continue` and follow it with `work_feed` and `work_status`.
- `work_cancel` on a standing job with nothing running returns `pendingQuestions`, the questions T3 still lists for its thread, and says they need an answer with `work_respond`: interrupting a turn that waited on a question may leave the question pending and the job `needs_input`. Its description also says the interrupted turn may be one the operator started in T3.
- Coordinators that delegate: every job view has `waitingOnDelegatedWork` and `delegatedTasks`, from the thread's `subagent` items that T3 shows as still running (followed by item id until they finish). A turn that ends with delegated work running is reported with reason `waiting_on_delegated_work`, and a turn the job starts by itself (T3 resuming a coordinator when its child finishes, or a person typing in T3) with reason `turn_started` (or `turn_finished` when it began and ended between two checks). The idle state meaning, the attention reasons and the `work_continue`, `work_feed` and `work_status` descriptions now tell agents that a coordinator goes idle while its delegated work runs and resumes by itself: read its reply, and if it delegated or is waiting, wait for its next turn instead of sending instructions. Schema migration 3 adds `jobs.delegated_work`.
- Delegated work that ends without the coordinator resuming (a child that failed or was cancelled, and T3 started no new parent run): the watcher appends the new event `delegated_work_ended` (reason `no_turn_started`), and the job enters `work_feed`'s attention list with "Its delegated work has ended (finished, failed or cancelled) but it did not resume. Send work_continue asking it to check on that work." The idle state meaning, the attention reasons and the `work_continue`, `work_feed` and `work_status` descriptions now say that `waitingOnDelegatedWork` wins over the reply text when they disagree (live, T3 shows a running child's `subagent` item as `running`, then `completed`).
- Delegated tasks followed per job raised from 20 to 200. Running tasks beyond those are counted in the new job view field `delegatedTasksUntracked` instead of being dropped; while it is above 0, `waitingOnDelegatedWork` stays true until the coordinator has run a new turn, and the attention reason says `following 200 of N delegated tasks; ask the coordinator for status before sending more work`. A job that finishes (`cancelled`, `failed`, `released`) no longer keeps its delegated work. Schema migration 5 adds `jobs.delegated_untracked`, `jobs.delegated_untracked_run_id` and `jobs.delegated_ended_at`.
- The adoption scan for delegated work keeps at least 5 of its 20 reads for looking back from the thread's last message, so a coordinator with a long activity tail after it is still found waiting.
- docs/operations.md gives the deploy order: stop the service, back up `gateway.db` and `gateway.key`, run `doctor` from the new checkout (it applies migrations and prints failures), then `install.sh`.
- `t3-fleet-gateway jobs list [--all]`: open jobs (with `--all`, finished ones too) with project, state, standing flag, title and link.
- Schema migration 2: `jobs.standing` and the terminal job state `released`, for standing jobs. It rebuilds the `jobs` table to change its state constraint and keeps every row, event and request id. Migrations are append-only from here on. Back up the data directory before updating a deployed gateway (see docs/operations.md).
- `doctor`'s public URL check requires this gateway's own metadata (`resource_name` `t3-fleet-gateway`), so another server's metadata for the same resource fails it.
- `clients token --name <name> [--access operate|read] [--ttl <duration>|never]`: a bearer token for an agent that cannot sign in with OAuth (Notion's custom MCP connections offer only header authentication). Printed once and stored as a hash; Operate and one year by default; listed by `clients list` with its expiry and cut off by `clients revoke`. Durations accept `y` (365 days).
- `work_messages` (read scope): a job's worker messages in full, read live from T3, up to 50,000 characters each, with `textTruncated` and `length`. Without `before` or `after` it returns the latest (`limit`, default 1, at most 10); `earlier` and `later` page back and forward. `work_status` has `excerptTruncated` (schema migration 6), and its summary and the attention reasons point to `work_messages` when the excerpt is cut.

### Fixed

- `mine: true` in `work_feed` and `work_list` left out standing jobs, so an agent filtering with it never saw the coordinator it drives. It now includes every standing job.
- Delegated work (`waitingOnDelegatedWork`, `delegatedTasks`) was never detected against a real T3: the watcher looked for `subagent` items in thread reads that named no view, and T3's default `messages` view returns only user and assistant messages and plans. The watcher now reads T3's `activity` view for delegated work, with a read position of its own (schema migration 4 adds `jobs.activity_position`) and one character per item, while replies, the excerpt and the job's state still come from the messages view, so a coordinator's reasoning and tool activity never delays them. Adoption starts the activity position at the thread's current end and finds delegated work still running with a bounded scan back from the last message; a standing job adopted before this update is scanned the same way on its first check. Every job, launched ones too, is checked for delegated work. Every thread read now names its view, and the test fake models both views.
- A pending item in a thread's timeline (a command still running, or a coordinator's delegated work, which stays pending for as long as the child works) held the watcher's read position back and hid every later message from the excerpt. Only a worker message still being written holds the position now, and the excerpt is the newest settled worker message read.
- Migration 2 failed on a version 1 database created by an early build of migration 1 (no `state_changed_at` or `t3_thread_link`, or a text `read_position`). It now copies the columns the table actually has, fills `state_changed_at` from `updated_at`, leaves `t3_thread_link` empty and converts `read_position` to an integer (empty when it is not a number). A failed migration, including a database locked by another process (`SQLITE_BUSY`), is now reported as `database_error` naming the migration, instead of a raw SQLite error.
- Approving in Chrome could leave the operator on the approval page: the form answered with a redirect to the client's callback, and Chrome applies the page's `form-action` to every redirect after a submission, so a callback that redirected on to another origin (as hosted clients' callbacks can) was blocked silently. Pressing Approve again then failed with "approval code was not accepted". The form now answers with a small page that navigates to the callback (meta refresh, plus a Continue link), for approvals, denials and request errors alike; `form-action` is `'self'` only. Submitting an approved form again shows the same authorization response while its code is unused and unexpired (no new code, no approval code spent, no failed attempt counted), and afterwards says the request was already approved.
- The CLI crashed with an unhandled `EPIPE` when its reader closed early (`t3-fleet-gateway pair | head -1`). Output to a closed pipe is now dropped and the command finishes with its own exit code; other stdout and stderr errors still fail it.
- `deploy/launchd/install.sh` could leave the service unloaded when reinstalling: `launchctl bootout` returns before launchd has removed the agent, and the immediate `bootstrap` failed with `Bootstrap failed: 5: Input/output error`. The installer now waits (up to 10 seconds) until the agent is gone and retries the bootstrap once; `--uninstall` waits too.
- The CLI silently ignored `--title`, `--all` and `--ttl` on commands that do not take them; they are now usage errors (exit 2) outside `jobs adopt`, `jobs list` and `pair` respectively.
- `deploy/launchd/install.sh` took any `launchctl print` failure as "the agent is unloaded". Only exit 113 ("Could not find service") counts now; another failure is reported with its exit status (`--uninstall` stops and keeps the plist).
- OAuth client ids could start with `-`, which `clients revoke <id>` read as an unknown option (exit 2); new ids never do, and `clients revoke -- <id>` revokes an earlier one.

### Known limitations

- `allowWorkStart: false` refuses new `work_start` calls only; jobs already queued in the project still dispatch.
- Permission approvals cannot be answered through T3's MCP tools; jobs waiting on one show `needs_input` with `waitingForApproval`, and the operator approves in T3. Projects that should run unattended need `runtimeMode` `auto` or `full-access`.
- The state derivation and worker-message detection follow T3's published tool schemas. A live run confirmed finished turns, worker replies, follow-ups and interrupting a running job; questions, approvals and failed runs are not yet confirmed against a real T3.
- An `unknown` job whose marker lookups keep failing with T3 errors stays `unknown`, holding its slot, until a lookup succeeds: a failed lookup is not evidence that the launch did not happen. Its `lastError` shows the failure.
- Node 26.0's bundled undici can throw `setTypeOfService EINVAL` as an uncaught exception when a peer resets a connection just as it opens (on macOS, for example when T3 restarts). `serve` logs it as `process.transient_socket_error` and keeps running, and the T3 client treats it as not delivered if it ever surfaces as a request failure; any other uncaught error stops `serve` gracefully with exit code 1 so its supervisor restarts it. The latest Node 24 or 26 release is recommended.
- A superseded sibling token pair's access token stays valid until it expires (see docs/security.md, "A refresh token is stolen").
