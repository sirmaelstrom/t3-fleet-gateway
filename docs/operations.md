# Operations

Run `t3-fleet-gateway` commands below as `node bin/t3-fleet-gateway.js` from a checkout. Every command accepts `--config`, `--data-dir`, `$T3FG_CONFIG` and `$T3FG_DATA_DIR` (see [configuration.md](configuration.md)). Exit codes are `0` for success, `1` for failure and `2` for usage errors. The CLI shares the running server's database, so CLI changes take effect without a restart.

For a problem you are seeing now, start with [troubleshooting by symptom](troubleshooting.md).

## Enroll a host

```sh
t3-fleet-gateway hosts enroll <host id>
```

Runs T3's pairing-code approval for the host (see [security.md](security.md#the-automated-t3-consent-step)): registers with T3, runs the host's `mintPairingCode` command, approves with the configured `access`, exchanges the code, verifies the credential with `t3_environment_read`, and stores it. It prints the T3 version and the expiry, never the credential.

Re-running it replaces the credential (the old one keeps working until it expires or you revoke it in T3). Common failures:

- `pairing_command_failed`: the command exited nonzero or did not print JSON with `credential`. Run it by hand; make sure it includes `--json` and that `t3` is on the service's `PATH`.
- `enrollment_failed`: T3 rejected the approval or the new credential did not verify.
- `host_unreachable`: nothing answered at `t3Url`.

## Check host credentials

```sh
t3-fleet-gateway hosts status
```

For each host: reachability and T3 version (checked live), credential state (`missing`, `active`, `renewal_due`, `expired`) with its expiry, and the last renewal failure if there is one. If T3 answers but refuses the stored credential (for example after its session was revoked in T3), the credential shows as `rejected by T3` with the error; run `hosts enroll <id>` again. Agents see the same as `credential.state: "rejected"` in `fleet_status`.

## Connect an agent

1. Add `https://<publicUrl>/mcp` as a remote MCP server in the agent.
2. When the agent opens the approval page, mint a code on the gateway machine:

   ```sh
   t3-fleet-gateway pair            # valid 15 minutes
   t3-fleet-gateway pair --ttl 1h   # 1m to 24h
   ```

3. Enter the code, choose **Read** or **Operate**, choose the machines, approve.

**Machines.** *All machines* is a fleet-wide grant (`fleet:read`, `fleet:operate`): every configured host, including hosts you add later, exactly what every grant before v0.1.5 was. *Selected machines* grants only the ticked hosts (scopes `host:<id>:read` and `host:<id>:operate`, see [design.md](design.md#per-host-grants)): the agent's `fleet_status` lists only those hosts and their projects and standing jobs, `work_list` and `work_feed` hold only their jobs, and every job tool answers a job on another host as if it did not exist. A host added later is not included; approve the agent again to add it. The page lists every configured host by label and id. Ticking machines while *All machines* is chosen, choosing *Selected machines* with none ticked, or anything malformed is refused before the code is used, so you can correct it and approve with the same code. A refused page, including one with a wrong code, comes back with your machines and access as you chose them, so correcting the code alone never grants more. An agent that asks for host scopes itself (scope `host:<id>:…`) cannot be given more than it asked for; agents that ask for the advertised fleet scopes, as MCP SDKs do, can be given either.

To change an agent's machines, approve it again from the agent (its earlier grant stays valid until revoked; revoke the client and reconnect to drop it), or for a bearer token mint a new one and revoke the old client.

Codes work once. Five wrong codes lock that approval page (start again from the agent); twenty failures in an hour pause all approvals until the hour clears. Minting a new code with `pair` lifts that pause at once, and `pair` says so when it does.

### Restricting a bot to projects

After connecting the bot, use its id from `clients list`:

```sh
t3-fleet-gateway clients projects <client-id> --project pilot --project @main/project-1
t3-fleet-gateway clients projects <client-id>                # inspect
t3-fleet-gateway clients projects <client-id> --no-projects  # deny every project
t3-fleet-gateway clients projects <client-id> --all-projects # remove project restrictions
```

Each change replaces the whole list and takes effect on the next request or notification attempt, without restarting or reissuing tokens. It covers all of that client's OAuth and bearer tokens, including overlapping rotations. Aliases refer to configured projects on their configured host; explicit `@host/projectId` entries come from `fleet_projects` and stay tied to that host/id. For a title-only alias, grant the alias to accept queued work before its id is resolved at dispatch. This ceiling only narrows machine grants; it cannot add machine or Operate access. With no policy the bot retains its existing access. The CLI and private operator dashboard remain unrestricted operator interfaces.

Restricted bots see filtered discovery, jobs, threads, feeds and attention lists, and receive only allowed-project notifications. Notification history aggregates are withheld with `healthAvailable: false`; inspect full delivery health through the operator CLI/dashboard. A policy change prevents later denied deliveries, including retries and replay; it cannot recall a request already sent to a receiver.

### Agents that only take a bearer token

Inspect token IDs and usage with `clients tokens <client id>`. Rotate using `clients rotate <client id> --token-id <id> --overlap 7d --ttl 1y`, and paste the replacement privately into the bot before the old token's deadline. Overlap must be explicit (0 to 30d); it never extends the old expiry. `clients revoke-token <client id> --token-id <id>` cuts off one token immediately. `clients revoke <client id>` cuts off all its tokens. Counts are authenticated tool calls in the current UTC hour and the last 24 UTC hour buckets, including refused tools; last use is unknown until the first recorded call.

Some agents cannot sign in with OAuth and only offer a bearer token or API key field (Notion's custom MCP connections, for example). Mint a token for one such agent:

```sh
t3-fleet-gateway clients token --name notion                          # Operate, valid 1 year
t3-fleet-gateway clients token --name notion --access read --ttl 90d  # read-only, 90 days
t3-fleet-gateway clients token --name notion --ttl never              # does not expire
t3-fleet-gateway clients token --name notion --hosts main,studio      # only these hosts
```

The token is printed once; the gateway keeps only its hash. Paste it into the agent's bearer token setting (it sends `Authorization: Bearer <token>`). `--access` is `operate` (the default, which includes read, as on the approval page) or `read`; `--ttl` is from `1h` to `100y` (units `h`, `d`, `y`), or `never`. `--hosts` is `all` (the default when omitted: every host, including hosts added later) or a comma-separated list of host ids from the config, such as `main,studio`; the token then works only for those hosts, as Selected machines does. An empty, malformed or unknown host list is refused and creates nothing. Each token is a client of its own: `clients list` shows it as `bearer token` with its expiry, and `clients revoke <id>` cuts it off at once. There is no refresh: when it expires, mint a new one and revoke the old client. A static token is only as safe as the place that stores it; see [security.md](security.md#threats-and-mitigations).

## Throttles

Registration and approval are open to anyone who can reach the public URL, so both are rate-limited, and you can clear both:

| Limit | Value | Recovery |
| --- | --- | --- |
| Wrong approval codes per approval page | 5 | Start the connection again from the agent (a new page), or `throttle reset` |
| Wrong approval codes across all pages | 20 per rolling hour | Mint a code with `pair` (lifts the pause), wait for the hour, or `throttle reset` |
| Client registrations | 30 per hour; a client that has not completed an approval stops counting after 10 minutes | Wait 10 minutes, or `throttle reset` |

```sh
t3-fleet-gateway throttle status   # failed approvals and registrations counting toward the limits
t3-fleet-gateway throttle reset    # clear both, locked approval pages included
```

Throttling is logged as `oauth.approval_throttled` and `oauth.registration_throttled` (warn). Repeated throttling without you connecting an agent means someone is probing the URL: see [security.md](security.md#threats-and-mitigations).

## List and revoke agents

```sh
t3-fleet-gateway clients list
t3-fleet-gateway clients diagnose <client-id>
t3-fleet-gateway clients revoke <client id>   # an id that starts with '-': clients revoke -- <client id>
```

`list` shows each client's id, name, granted access (`operate (all hosts)` or `read (all hosts)` for fleet-wide grants; `operate: main, studio` or `read: main` for selected hosts), status, creation and last-use times, and how it signs in: the origins an OAuth client redirects to, or `bearer token` with the expiry of a token minted with `clients token`. Status is `pending` only when no grant family exists, `grants revoked` when families exist but all are revoked, `unrevoked` when an OAuth family is unrevoked regardless of usability, and `active` or `expired` for an unrevoked operator token. A revoked client always shows `revoked`; one revoked family does not hide another unrevoked family. For `grants revoked`, run `clients diagnose <client-id>` to see the reason; an OAuth agent needs a new approval. `revoke` takes effect immediately for every token the client holds; an OAuth agent must register and be approved again, while a static bearer client needs a replacement token.

## Authentication and outage recovery

`clients diagnose <client-id>` is an offline store read, using the configured canonical MCP resource. It does not contact T3, mint credentials, run renewal/model probes, or test ingress. Reachability is **unknown**. Run `doctor` and inspect its **public URL** result to test the operator's route at that moment; that does not prove the cloud connector's route works. Doctor's host checks concern downstream T3 credentials and reachability, separately from the agent's gateway sign-in. For each grant, diagnose also prints the access it was approved with (`granted access: operate (all hosts)`, or the selected hosts) and names any of those hosts that are no longer configured (no access there unless a host with that id is configured again).

Diagnosis shows kind (`oauth` or static `bearer`), client revocation time, and usable access/refresh capability across all grant families. State is `pending` for no family, `revoked` for a revoked client, `active` for at least one usable access grant, `refreshable` for no usable access but a usable refresh grant, and otherwise `unusable`. A revoked or expired family never masks another usable family. Family summaries show revocation times/reasons and counts with earliest/latest expiries for each token state; `never` is supported for operator bearer access. An unrevoked count alone says nothing about expiry or usability.

Access is usable only when client, family and access token are unrevoked, its expiry is strictly later than the check time, and its resource matches. Refresh summaries distinguish unused usable tokens, accepted rotated-parent `grace_retry` tokens (up to and including two minutes), expired tokens, superseded siblings, replay-invalid parents (outside grace or with a rotated child), revocation and wrong canonical resource. A superseded sibling's access can remain usable until expiry. A refresh for the configured resource must match that grant's resource; the token endpoint retains its existing optional `resource` behavior. Diagnosis neither consumes nor revokes a grant. It cannot know which token/sibling the connector saved: server capability is not proof that its saved token works.

`Last successful MCP` is a completed authorized HTTP 2xx exchange (including 202 notifications and valid tool errors). Rejected authentication/Origin, malformed or failed HTTP requests do not count. Writes are sampled at most once per minute per client: the displayed time may lag the latest success by up to a minute. `Last successful refresh` is successful pair issuance committed in the refresh transaction, including accepted grace retries; every issuance updates it, rejected refresh does not. Both start **unknown** (null) after migration 7; the older mixed `LAST USED` is preserved, never fabricated into either field. Unknown cannot distinguish old history from never observed. MCP HTTP completion proves the gateway sent the exchange, not that the connector saved its result.

Recovery sequence:

1. Preserve the connector's saved OAuth credentials, registered client identity, and feed cursor. Inspect its routine status; a routine that disabled itself must be re-enabled by its operator. The gateway cannot restart it.
2. Run `clients diagnose <client-id>`, then `doctor`. Fix ingress failures before interpreting them as broken sign-in. Compare operator-route evidence with connector-side failures; neither stale timestamps nor expired access alone prove revocation.
3. After ingress returns, reconnect using the same OAuth token store. The SDK can refresh a usable saved refresh token on the gateway's 401 challenge. If the saved refresh is expired, revoked, superseded or replay-invalid, complete a new approval; diagnose may still show a usable sibling that this connector did not save. For static bearer clients, use `clients token --name <name>` and replace the connector header when expiry/revocation requires it; there is no refresh.
4. Resume `work_feed` with the last durably saved `nextCursor` (the feed returns only later events). Save the new cursor only after processing that page. For an uncertain `work_start`, `work_continue` or `work_respond`, reuse the original request id **and identical input**; never invent a new request id merely because the response was lost. Check `work_status` for uncertain cancellation/delivery.
5. Re-enable the polling routine if needed and verify another successful exchange. Larger access/refresh TTLs do not restore reachability or restart disabled routines.

**Verified client limits:** the installed `@modelcontextprotocol/client` 2.3.1 source (`src/client/streamableHttp.ts`, `src/client/auth.ts`, distributed in `dist/index.mjs`) retries an MCP HTTP request once after 401 reauthentication. It does not automatically retry a failed JSON POST after a network error. Its SSE reconnect defaults are two attempts, starting at 1 second with a 1.5 multiplier and 30-second cap (server retry hints can override delays); this stateless JSON gateway has no SSE session to resume and GET answers 405. The OAuth orchestrator retries auth once on specific credential errors (`invalid_client`, `unauthorized_client`, `invalid_grant`, `invalid_dpop_proof`), using the provider's invalidation hook where available. A refresh network/server error after an auth challenge may fall back to a new authorization request; do not automatically erase stored credentials or approve a replacement just because connectivity failed. The regression cuts ingress before any challenge and proves that this failure preserves credentials and the cursor, then refreshes successfully on reconnection with one approval/job/launch.

These are SDK behaviors, not Grok or Notion commitments. Their actual retries, routine-disable thresholds, persistence and end-to-end recovery remain unverified. Live testing against a real T3-backed gateway confirmed SDK ingress recovery (see "Verified behavior" below); hosted connector recovery and downstream T3 outage recovery remain unverified.

## Credential renewal

T3 credentials last 30 days. `serve` checks at startup and every `renewal.checkEveryMinutes`, and re-enrolls any host with fewer than `renewal.renewWhenDaysLeft` days left (or already expired). The old credential stays in use until the new one is verified. Enrollment failures are logged as `host.enrollment_failed`, shown by `hosts status` and `doctor`, and reported to agents in `fleet_status` as `credential.renewalError`; the next check retries. Hosts that were never enrolled are not enrolled automatically (`serve` logs `host.not_enrolled` at startup).

Credential alerts are checked at startup and on the same renewal interval. `renewal.alertDaysLeft` defaults to `[7, 2]`: a warning within seven days and an escalation within two days, evaluated only after a renewal attempt fails, plus a separate failure alert. Configure one to eight integer thresholds from 1 to 29 days; duplicate values do not duplicate events. This does not change the default five-day automatic renewal window. Alerts persist across restarts, dedupe while active, and resolve after verified renewal. Healthy renewal cycles emit zero alerts, even with late checks or short-lived successful replacements. A threshold above the renewal window does not warn before a failure. A host that has never been enrolled still requires explicit enrollment.

Delivery uses existing webhook connections, their filters, retry behavior and delivery health. New connections include `credential_alert` and `credential_resolved`. **Existing connections retain their saved event selections, including file-managed routes that omit `events`.** On the private Webhooks page, check **Credential alerts**. For a dashboard connection, choose **Replace key**, paste its full authorization header, and add `credential_alert, credential_resolved` to **Events**, keeping the other desired events; leave the URL blank to keep it. The synthetic test must succeed before the update takes effect. For file-managed connections, include both events in `webhooks.subscriptions[].events` through the normal configuration workflow. Deliberately restricted selections are never silently broadened. Updating a route cancels its previous queue as usual.

Every configured host/project/target/job/client filter must match. A host alert on a precise job/client route requires a matching ledger job. Bot-owned connections also require an owned job binding that explicitly includes both credential events (use `work_subscribe`); a job-only subscription does not confer unrelated host notifications. Paired targets must match both host and project, established from configuration or the ledger. Credential events have no job feed cursor, worker content or raw failure text. Their payload is `{eventId,type,timestamp,feedSequence:null,feedCursor:null,host,reason,thresholdDays,expiresAt,alertId}`; reason is `renewal_failed` or `expiry`, and threshold is null for failure. Retries retain the event ID; raise/resolution share the alert ID. They use the normal one-hour delivery window and persistent delivery health but are outside job cursor replay. If delivery fails, the private Hosts page and `doctor` retain current alert state. Configure and test at least one matching connection to receive proactive alerts.

To recover from a failed renewal, open **Hosts → Re-pair**, read the confirmation, then choose **Confirm re-pair**. The gateway runs the host's existing pairing command, obtains a candidate credential, verifies it against T3, and only then installs it atomically with success and alert-resolution bookkeeping. A command, pairing, verification or transaction failure keeps the old credential. No code or token is displayed or pasted. Confirmation expires after five minutes; duplicate confirmation requests share/replay one result. If the response is lost, inspect Hosts before starting a new confirmation. Fix a missing or failing command first; re-pair does not repair command configuration. `hosts enroll <id>` remains the CLI alternative. Only operators who can reach the private dashboard can use this action; its existing mutation protections apply.

Migration 19 is additive and leaves existing credentials, jobs, routes, queue bytes and attempts unchanged. Stop all ledger users and take a private data-directory backup before upgrade. Older builds refuse schema 19. To roll back safely, stop the new build, restore that pre-upgrade backup and the previous configuration (remove `alertDaysLeft` and the new event names), then use the previous build. Writes after the backup are lost; no live rollback or re-pair is performed by this feature's tests.

Local enrollment diagnostics retain a bounded stage/reason, HTTP status, recognized T3/OAuth error or denial code, and command exit or resolution code. The log, stored renewal record, doctor and private dashboard use the same validated format. For example, `approval: http_error; HTTP 403; T3 access_denied` distinguishes a refusal from `preflight: executable_missing`. Raw T3 messages may echo credentials; unknown short codes may themselves be tokens. Neither is retained or displayed, and unknown codes become `unrecognized`. Alert/webhook payloads still carry no diagnostic text.

Startup also preflights the configured mint executable before starting automatic renewal, and logs `host.pairing_preflight` with only a host id and diagnostic code. All host checks settle before renewal starts; an unexpected check rejection logs `host.pairing_preflight_failed` with only the host id and still permits the loop to start unless shutdown has begun. Before each renewal, known missing/non-executable commands record `pairing_command_failed` and skip pairing registration. The old credential stays in place. Optional non-mutating probes are startup/doctor diagnostics; a failing probe or version warning alone does not block renewal. See [configuration.md](configuration.md#renewal-command-preflight).

## Jobs

Agents with **Operate** start work with `work_start`; the gateway queues the job, creates a T3 thread titled `<title> [job:<id>]` in a fresh worktree on branch `<branchPrefix><id>` (from the project's `baseRef`), and follows it. A scratch alias (`workspaceMode: "scratch"`, which includes a machine's `defaultProject` for work with no named project) is the exception: its jobs run in the pinned T3 project's own scratch workspace, with no worktree or branch from the gateway. What to know as the operator:

- **Find a job in T3** by searching for its id or `[job:<id>]`. Every job is an ordinary thread: read it, type into it, stop it. If you stop it, the job becomes `idle` (the agent can continue it); if you type into an idle job's thread, the gateway records the extra turn.
- **Approvals.** Threads run with the project's `runtimeMode`. With `approval-required`, permission approvals wait for you in T3; the job shows `needs_input` with `waitingForApproval` and agents cannot answer it. Worker questions (not approvals) can be answered by agents with `work_respond`. `work_status` includes full actionable questions in MCP text as well as structured content, including required/custom-answer/selection flags (null means unspecified). It reads five requests by default; pass `pendingRequestId` to read another listed request. `questionsUnavailable` distinguishes `read_limit`, `temporarily_unreadable` and `too_large`. Retry unreadable questions; a whole request exceeding 50 questions, 100 options per question or 64,000 JSON characters requires the operator to answer in T3. No partial required questions or option values are returned.

  Unspecified flags alone do not require escalation or prevent an answer. Follow explicit question wording; when there is no instruction to select several, try a single listed value (or its label if no value is supplied) as a conservative answer attempt. This is not a claim about T3 defaults: T3 validates the answer. After uncertain delivery, consult `work_status` before retrying. Synthetic text-only tests cover omitted/null flags; a live Codex test accepted a real single listed label answer with absent flags. Other providers, multi-select/custom answers and rejected-answer retention remain unconfirmed live.
- **Concurrency.** At most `maxConcurrentJobs` jobs per host hold a slot (`dispatching`, `running`, `needs_input`, `cancel_requested`, `unknown`); the rest wait as `queued`. `fleet_status` shows the counts. An `idle` job holds no slot.
- **Host down.** Jobs keep their state; `work_status` shows `hostUnreachableSince` and the gateway retries with backoff (up to every 5 minutes). Queued jobs launch when the host is back.
- **Unknown launches.** On a session advertising launch retry keys, the gateway first retries one transport failure with the same job-derived `clientRequestId` and identical launch input. Legacy hosts keep the earlier behavior. If a launch's response is still lost, the job is `unknown` and the gateway looks for `[job:<id>]` in the project's threads. Found: it continues, unless T3 created the thread but never started a run on it (the task was not delivered): then `failed` with `launch_not_started`, and the job keeps the thread's id and link so you can inspect it. Not found for `watcher.reconcileWindowMinutes` (default 10) while the host answers: `failed` with `launch_not_confirmed`. The gateway never launches twice; the agent decides whether to start again.
- **Cleanup.** Cancelled, failed and finished jobs leave their T3 thread, worktree and branch in place for you. Remove them in T3 or with git when you no longer need them. A scratch job has no gateway-created worktree or branch (its `branch` is empty); T3 owns the folders of its scratch workspace.
- **Scratch jobs.** A job started with `target: { host }`, or in a scratch alias, shows the alias as its project (`jobs list`, `work_*` views, webhooks and the dashboard all name the alias and host; the `work_*` views alone add `workspaceMode`, here `scratch`, and no T3 project name). It is recorded from the configuration without reading T3 (`launch_spec` version 2), so it queues while the host is down, and the dispatcher checks it again right before launching, against the host's project list: if the alias, its pinned project, workspace mode, runtime mode or `allowWorkStart`, the host's `defaultProject`, or the host's `access` ceiling changed while the job was queued, it fails with `launch_policy_changed` and nothing is launched (`project_not_configured` if the alias was removed, `project_not_found` if the T3 project is gone). A scratch launch sends no project id, so T3 chooses the project: if it answers with another id than the pin, the job follows its thread and the gateway logs `job.scratch_project_mismatch` (job and host ids only); fix the pin, which must be T3's internal scratch project. Start the work again under the current configuration. See [configuration.md](configuration.md#no-named-project) for setup and the upgrade notes.
- **A stored launch plan the gateway cannot read.** A job's `launch_spec` that is damaged, or was written by a build that knows more, stops nothing else. A queued job in that state is never launched: it fails with `database_error` ("This job's stored launch plan could not be read. Start the work again."), and the jobs behind it dispatch in the same tick. A job that already has a thread is followed as usual, and its views lack the project name, model and workspace mode. The first read of such a job in each process logs `job.launch_spec_unreadable` (job id, host and state only, never the stored text). Nothing rewrites the stored text; the work is started again as a new job.
- **Standing jobs.** Register a thread you already work in (for example a long-running coordinator thread) so agents can drive it; see below.
- **Discovered projects.** With `discovery` enabled on a host ([configuration.md](configuration.md#discovery)), agents can list its T3 projects and models (`fleet_projects`, `fleet_models`) and, if you also allow it, start work in a T3 project that has no `projects[]` entry. Such a job shows its project as `@<host>/<projectId>` in `jobs list` and the tools, and records what it resolved to (`launch_spec`) so later config or catalog changes do not move it. A project that has an alias is always launched as that alias, whatever the agent passed. Right before the launch the gateway reads the host's project list again: a project renamed in T3 into a configured alias's title, an alias whose title moved to another project, or a project that no longer accepts work fails the job with `launch_policy_changed` before any launch, and an explicit model selection the host no longer advertises fails it with `model_selection_invalid`. Such a job is not retried; start the work again under the current policy (`fleet_projects` shows it).
- **Uncertain plain follow-ups.** Retry with the same `requestId` and the same T3 authorization identity. The private ledger records an identity digest before delivery. If authorization renewed or an older unfinished send has no identity metadata, the retry fails closed with `t3_response_lost`; inspect the thread before submitting new work. Completed requests still replay their stored result. No schema migration is needed.
- **Restarts** are safe at any time: job state is in the database, and the next start resumes watching every unfinished job and reconciles any launch that was in flight.

### Standing jobs

A standing job is a T3 thread you created and keep, which agents send work to with `work_continue` and follow with `work_feed` and `work_status`, instead of launching new threads. Typical use: a "chief of staff" thread that coordinates a project (and may delegate to child threads of its own), driven by Grok Bot. Only you can register one:

```sh
t3-fleet-gateway jobs adopt <project alias> <T3 thread id> [--title "Chief of Staff"]
t3-fleet-gateway jobs list [--all]      # id, project, state, standing, title, link; --all includes finished jobs
t3-fleet-gateway jobs release <job id>
```

- **Adopt** checks with the project's host that the thread exists and belongs to that project's T3 project, then records it and prints the job id, state and link. Copy the thread id from T3 (the thread's link ends with it). Its state comes from the thread now (`running`, `needs_input` or `idle`); earlier history is not reported to agents as new activity. Adopting the same thread again prints the existing job; a thread a launched job already follows is refused. `--title` is what agents see (default: the thread's T3 title). The running gateway starts following the job within one poll; no restart is needed.
- **Agents** see it in `work_list`, `work_feed`, `work_status` with `standing: true`, and in `fleet_status` under its project. `work_cancel` only interrupts the current turn, which may be one you started in T3; the job returns to `idle` and stays open. If the turn was waiting on a question and T3 still lists it after the interrupt, the job stays `needs_input` until an agent answers it (`work_respond`) or you dismiss it in T3. A failed run also leaves it `idle`, with the error in `lastError`.
- **Delegation.** A coordinator that hands work to child threads ends its own turn while they work, so the job is `idle` meanwhile, with `waitingOnDelegatedWork: true` and the tasks' titles while T3 shows that work running; when a child finishes, T3 starts the coordinator's next turn by itself and the job goes `running` (reason `turn_started`) and then `idle` again. Agents are told to wait for that turn instead of sending new instructions. Child threads are not jobs and their messages are never reported as the coordinator's reply.
- **Concurrency.** Standing jobs never hold one of the host's `maxConcurrentJobs` slots, running or not.
- **Make it the only way in.** Set `allowWorkStart: false` on the project ([configuration.md](configuration.md#projects-with-a-coordinator)): agents' `work_start` there is refused with `start_disabled`, naming the standing jobs to use with `work_continue` instead.
- **Release** stops following it: the job becomes `released` (terminal) and agents can no longer send it work. The gateway makes no T3 call: the thread, and anything running on it, are left exactly as they are. You can adopt the thread again later as a new job.

## Doctor

```sh
t3-fleet-gateway doctor
```

Checks, in order: the config, data directory permissions, database integrity and schema version, each host's credential and live reachability plus mint executable resolution and any explicit non-mutating probe, that each project resolves to a T3 project and has a model (its own `modelSelection`, its host's `defaultModelSelection`, or the T3 project's default model; without one T3 refuses every launch), and that `publicUrl` serves this gateway's protected resource metadata (which needs `serve` and the tunnel running): the `resource` must be `<publicUrl>/mcp` and `resource_name` must be `t3-fleet-gateway`, so another server behind the same URL (T3 itself behind a different proxy, say) fails with "serves a different server's metadata". With the dashboard enabled, it also checks that the dashboard answers on its loopback listener and that the public URL does not serve it (see "Operator dashboard"). Each line is `OK`, `WARN` or `FAIL`; any `FAIL` exits `1`.

Mint checks use doctor's actual environment: repeat with the service's PATH to verify service resolution. Missing/non-executable commands fail before a future renewal needs them, even when T3 is healthy and its credential is active. Version-pinned paths warn. Without `mintPairingCodeProbe`, wrapper internals, remote execution and CLI version remain explicitly unverified; nothing is minted to test them. Only an explicitly configured safe probe is run (ten-second deadline, 4,096 bytes per output stream; it was two seconds before 0.1.7, which a Background launchd agent can exceed), with fixed diagnostics and no raw command output or argv. Version comparison accepts bare semver, exact native `t3 v<semver>` output and JSON `{"version":"x.y.z"}`. Doctor uses fresh health; startup uses only completed, unexpired cached health (otherwise comparison remains unverified), with no preflight health request. Disagreement warns without declaring incompatibility. See [configuration.md](configuration.md#renewal-command-preflight).

## Operator dashboard

A private page for you, the operator: is the gateway running, do the hosts answer, which agents can connect and which actually did, what work is waiting on you, and what happened recently. The Webhooks view also connects notification receivers; monitoring views remain read-only. Approvals, answers and stopping work happen in T3; enrolling hosts, approving and revoking agents happen in this CLI. Design: [design.md](design.md#operator-dashboard); trust boundary: [security.md](security.md#the-operator-dashboard).

### Turn it on

1. In the config, add a `dashboard` block ([configuration.md](configuration.md#dashboard)) with `"enabled": true`, a loopback `listen` on its own port (default `3791`, never `listen.port`) and a `basePath` you will mount it under, for example `/t3-fleet-gateway`. Optionally set `transportNote` on hosts (`"SSH tunnel"`, `"Same machine"`) and `clientLabels` for connectors whose registered name is not the one you know them by (`clients list` shows the ids).
2. Restart the service (see "Run as a service": stop, update, `doctor`, install). `serve` logs `dashboard.started` with the listener and path.
3. Publish it to your tailnet only, on a path of its own, keeping the path, for example with Tailscale:

   ```sh
   tailscale serve status    # see what is taken first
   tailscale serve --bg --https=443 --set-path /t3-fleet-gateway http://127.0.0.1:3791/t3-fleet-gateway
   ```

   Use `tailscale serve`, never `tailscale funnel`: Funnel would publish it to the internet. (The dashboard refuses requests Tailscale marks as Funnel traffic anyway.) Then add the host name your browser uses (`<machine>.<tailnet>.ts.net`) to `dashboard.allowedHosts` and restart; until then the page answers `421` "This host name is not allowed". On the gateway machine itself, `http://127.0.0.1:3791/t3-fleet-gateway/` always works.
4. Run `doctor`. With the dashboard enabled it adds two lines: `dashboard` (it answers on its loopback listener) and `dashboard exposure` (the public MCP URL does **not** serve it, checked through your real tunnel). A `FAIL` on the second means your public tunnel points at the dashboard's port: point it at `listen.port`.

To turn it off: `tailscale serve --https=443 --set-path /t3-fleet-gateway off`, set `enabled` to `false` and restart.

### Reading it

- **Overview** opens with what needs you, most serious first, each saying where to act: a T3 thread link (`Open in T3`), a command to run on the gateway machine (copyable), or a dashboard view. The map shows agents → gateway → hosts with each one's state.
- **Hosts.** Reachability is the **last** health check the gateway made, with its time; opening the page never contacts T3. `Not checked yet` means none since the gateway started: press **Run checks**. `No answer` means nothing answered at the host's `t3Url`; the gateway cannot tell which hop failed (an SSH tunnel, the network or T3), and the transport note is only your description. `Refused credential` means T3 answered but rejected the stored credential: run `hosts enroll <id>`. Jobs on an unreachable host keep their state.
- **Clients** separate *Authorization* (what the gateway would accept now: grant state, the access its usable tokens carry, expiries; *Approved for* appears when the approval was wider, after a narrowed refresh or once the wider tokens expired) from *Observed* (the last successful MCP request and refresh). `Never observed` and `unknown` mean nothing was recorded, not that the connector is broken; `Seen recently` means a request completed in the last day, not that the connector's routine keeps running; a usable grant does not prove the connector still holds its token. `Needs new approval` / `Token unusable` mean no usable grant is left. A grant revoked for token reuse is flagged: run `clients diagnose <id>`. A bearer token expiring soon comes with a `clients token` command that keeps its access and hosts; check it before running it.
- **Jobs** lists jobs waiting on someone or recently finished, open jobs and finished ones, with state, host, who started it and a link to its T3 thread. No task text, replies or questions are shown; open the thread in T3. The activity log shows job events as codes.
- **Run checks** asks every host now (one read-only call each), checks the public URL's metadata from this machine, confirms the public URL does not serve the dashboard, and checks the database, the data directory and whether the renewal command resolves. Nothing is enrolled, renewed or executed. Each host gets five seconds in all; one that has not answered by then is reported as `t3_timeout`, and a late answer shows on Hosts with its own time. Failures and warnings also appear on the Overview until the next run. What it cannot tell (a connector's own route, which tunnel hop failed, whether a connector holds its token) is listed on the page.

The page reloads its data when you open it, press Refresh, or come back to it after a minute. Automatic refresh pauses while a webhook form is open so switching to Grok does not erase pasted values; explicit Refresh clears them. There are no alerts and no background polling of T3.

### Connect a webhook receiver

From **Overview**, choose **Connect Grok Bot**, or open **Webhooks**. For Grok, ask the bot to show clickable links named **Webhook URL**, **Webhook key** and **Authorization header**; these open private panels. Ask it not to print the key in the conversation. Copy **POST to** from the URL panel and the complete **header** from the authorization panel. The full header already contains the key, so there is no separate key field in the dashboard.

1. Paste the **Webhook URL**. This is where the gateway sends job notices.
2. Paste the **Full authorization header**, including its name and value, for example `Authorization: Bearer example-key`. This tells the receiver to accept the request. Any supported HTTPS receiver and authentication header can be used.
3. Choose a **Project** under its host group. Configured aliases are always listed; enrolled hosts with discovery enabled also list their T3 projects by name and ID. An unreachable host is marked unavailable while other hosts remain selectable. Refresh retries discovery. A discovered selection matches the exact host and project ID, including alias and direct-target jobs.
4. Select **Connect & Test**. The gateway sends a synthetic test before saving. If accepted, check the bot conversation to confirm its response: an HTTP success does not prove the bot finished.

A successful **Connect & Test** immediately saves and activates the gateway connection; there is no separate “saved” or enable button. If the receiver requires saving or enabling its routine, complete that step there. HTTP 2xx proves acceptance only.

The connection sends notices when a job finishes a turn (`idle`), needs input, fails, is cancelled, or stops waiting for delegated work. Worker excerpts stay off. No files or restart are needed, and the saved URL and key are never shown again. The list shows project, host, management source and safe last-test status/time.

Existing connections survive the host/project-target upgrade unchanged; do not re-register them. If a key was exposed, rotate it at the receiver, then use **Replace key** with the new full header (and new URL if changed). Never paste keys into chat or logs.

**Send test** checks an existing connection. **Replace key** tests a new full header and, optionally, a new URL before replacing the old route. Recreating a bot routine changes both its URL and key: replace both. A failed test keeps the old connection working. **Disconnect** asks for confirmation and cancels its queued notices; a request already sent cannot be recalled. File-managed rows must be changed in their configuration and secret file; the dashboard labels them and cannot replace or disconnect them. The CLI's `webhooks list`, `webhooks attempts <id>` and `webhooks ping <id>` work with either source without exporting secrets.

A 401/403 test means the receiver refused authentication. Check the full header and current routine URL. A timeout means no complete response arrived within ten seconds; it does not prove the receiver never received the test. Tests do not automatically retry. If another operator changes or disconnects a row while your test runs, refresh and use its current state. Management is unavailable during startup and shutdown. Keep the dashboard private: anyone who can reach it can manage these destinations.

### Dashboard demo

`npm run dashboard:demo` (or `node scripts/dashboard-demo.ts`) runs the dashboard on a synthetic fleet: a real gateway with a temporary data directory, three fake T3 hosts on loopback and the fictional clients Grok Bot, Muse and Notion, seeded through the gateway's own sign-in and tools. It never reads your config or data directory and contacts nothing beyond loopback. Options: `--scenario mixed|healthy|host-down|auth-issue|empty` (`--list` describes them; `mixed` is the default and the richest), `--port 4791` (`0` picks one), `--base-path /t3-fleet-gateway`, `--no-badge` to hide the "Synthetic demo" badge for screenshots, and `--webhook-receiver` for a local synthetic setup receiver. It prints the URL and runs until Ctrl-C, which deletes the temporary directory. Use it for screenshots and browser checks; never point it at production data.

For a functional webhook setup check:

```sh
npm run dashboard:demo -- --scenario empty --port 0 --webhook-receiver
```

Open the printed dashboard URL and select **Connect Grok Bot**. Paste the printed `/accept` URL and the fictional full header `Authorization: Bearer demo-only-key`, then choose `atlas-web`. The receiver accepts with HTTP 202. To exercise a failed replacement, choose **Replace key**, paste the printed `/reject` URL and the same header, then submit: HTTP 401 leaves the working connection in place. The printed `/timeout` URL stalls until the demo's one-second attempt deadline. **Send test** should still succeed on the original connection after either failure. Finally disconnect and confirm the row is removed. All receiver request bodies and headers are discarded; only counts are held in memory. This demo permits only literal-loopback destinations, enables local HTTP explicitly, and cannot target a real bot. Ctrl-C shuts down the gateway and receiver and deletes the temporary database. Production retains normal HTTPS validation and the ten-second deadline.

## Developer compatibility check

Run this manually after a T3 update or when investigating a possible API change:

```sh
npm run compat:check
# Establish the first baseline, or accept inspected changes after successful checks:
npm run compat:check -- --accept
# Machine-readable output (direct invocation avoids npm's own header):
node scripts/check-t3-compatibility.ts --json
```

This developer tool is separate from the running gateway and `doctor`. It installs no scheduler and adds no client-facing status fields or alerts. Each invocation performs fresh discovery and reads; it can later be called by a developer's chosen automation, at a twelve-hour interval or another cadence.

The script uses the existing config and enrolled credentials (`T3FG_CONFIG`, `T3FG_DATA_DIR`, or `--config` / `--data-dir`). It opens the credential database read-only: no schema migrations, credential minting/renewal, job records or configuration writes. It never launches, sends, responds to, interrupts or creates a T3 thread. `--host <id>` restricts the check to one configured host.

It walks all `tools/list` pages with bounds, rejecting repeated cursors, duplicate tools and incomplete discovery. It snapshots the T3 tools used by the gateway (`orchestrator_capabilities` included), selecting `t3_pending_request` when advertised or requiring all three legacy pending-request tools otherwise: input schemas and optional output schemas. It ignores unrelated tools and descriptive annotations, normalizes object/set ordering, and preserves actual field names, defaults and ordered schemas. When schema references make that normalization unsafe, it conservatively retains the full structure; unsupported input references or validation features warn instead of claiming compatibility. Missing required tools fail. The combined tool is checked with list, read and respond samples; absence of the legacy names on a combined-tool host is valid. Compact schemas without null branches on optional fields or explicit `additionalProperties: true` are supported; schema simplifications may still appear as reviewable baseline drift. Other schema changes warn until reviewed; a changed schema is not automatically incompatible. Representative synthetic gateway inputs are validated locally against advertised input schemas, including mutation inputs (launches with the worktree strategy and with `scratch: true`) and long opaque request IDs. Rejected samples fail; schemas the validator cannot assess warn. When `t3_thread_organize` is advertised, its exact `{ threadId, action: "settle" }` input is also validated locally and its schema included in the baseline; the checker never executes settlement and does not require the tool on older hosts. These samples do not prove all possible inputs or mutation behavior work. MCP discovery and optional output schemas are described in the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

The read-only smoke checks use the existing gateway parsers in a separate MCP session, so discovery cannot change their SDK validation behavior. They read the environment, the capability catalog and up to five projects, try an existing thread in up to three projects (including settled threads), search one project, read one sampled thread in both `messages` and `activity` views with minimal text, and list its pending requests. One pending request is read if present. No thread or pending question available means explicit skipped coverage; the tool does not create work to fill that gap. Output-schema changes are compared, while live output parsing checks the fields consumed by the gateway. Unadvertised output schemas and unobserved states remain unverified.

Results include the current/previous T3 version, affected tool names and bounded schema paths, fixed check codes, skipped coverage and `changedSinceLastCheck`. Version changes are reported separately from schema changes. The change flag excludes timestamps and routine variation in successful sampled coverage; repeated identical failures remain visible but do not produce a new change. Exit codes are **0** for PASS, **1** for failed checks, **2** for a missing baseline/schema drift/unsupported validation needing review, and **3** for invocation or local-state errors. PASS means the advertised inputs and available sampled reads passed; it is not full live qualification.

The private state file is `~/.local/state/t3-fleet-gateway-compatibility/state.json` by default, overridable with `T3FG_COMPAT_STATE_DIR` or `--state-dir`. Its directory is mode 0700 and files 0600. It retains each host/endpoint's accepted schema baseline and the latest report; report output contains no tokens, thread contents, titles, questions, answers or raw error messages. `--accept` updates a host's baseline only after discovery and its available checks pass; failed or unsupported checks preserve the prior baseline. First use without `--accept` reports a missing baseline for review. Reports are replaced atomically, and concurrent runs using the same state directory are rejected with `check_in_progress`. If a process was killed and left `check.lock`, confirm no checker is running before removing that directory and retrying.

Automated tests use only synthetic hosts (`test/t3-contract.test.ts`, `test/t3-compatibility.test.ts`). Scheduled checks, notifications and full mutation QA are outside this tool's scope.

## Run as a service

Requirements: Node.js 24.22.1 or a later 24.x, or 26.12.1 or newer; the launcher and `install.sh` refuse older releases, which do not block the [compromised eMudhra intermediates](security.md#compromised-emudhra-intermediates). Upgrade Node before deploying a build that requires it, then restart the service. The latest Node 24 or 26 release is recommended. Node 26.0 can raise a spurious `setTypeOfService EINVAL` when T3 resets a new connection (see below).

macOS (launchd, per-user agent with KeepAlive):

```sh
deploy/launchd/install.sh --dry-run   # print the plist it would install
deploy/launchd/install.sh             # install and load
deploy/launchd/install.sh --uninstall # unload and remove the plist
```

The installer fills in absolute paths and puts the directories of `node` and `t3` on the service's `PATH`. Override any default with environment variables: `LABEL`, `REPO_DIR`, `NODE_BIN`, `T3_BIN`, `CONFIG_PATH`, `DATA_DIR`, `LOG_DIR`, `PLIST_DIR`.

Re-running the installer replaces the running agent. `launchctl bootout` returns before launchd has finished unloading it, and loading again in that window fails with `Bootstrap failed: 5: Input/output error`, so the installer waits (up to 10 seconds) until `launchctl print gui/<uid>/<label>` no longer finds the agent (exit 113, "Could not find service"), and retries the load once if it still fails. If `launchctl print` fails any other way, the installer says so with its exit status instead of assuming the agent is gone (`--uninstall` then stops and keeps the plist). `--uninstall` waits the same way before removing the plist.

**Run the service from its own checkout.** The service runs the code in `REPO_DIR` directly (there is no build step), so a checkout you develop in is a checkout you deploy from: switching branches, editing files or running `npm install` there changes what the next restart runs, and KeepAlive restarts happen without asking. Keep a separate clone for the service, update it deliberately, and install from it:

```sh
git clone /path/to/your/working/checkout ~/.local/lib/t3-fleet-gateway   # or clone from your remote
cd ~/.local/lib/t3-fleet-gateway && npm ci --omit=dev
deploy/launchd/install.sh             # REPO_DIR defaults to this clone
```

To deploy a new version into that clone, in this order, so a migration never runs under a live service and any failure is printed rather than buried in the service log:

1. Stop the service: `launchctl bootout gui/$(id -u)/local.t3-fleet-gateway` (wait until `launchctl print gui/$(id -u)/local.t3-fleet-gateway` no longer finds it).
2. Back up `gateway.db` and `gateway.key` from the data directory (see "Backup and restore"; with the service stopped, `cp -p` is enough).
3. Update the clone (`git -C ~/.local/lib/t3-fleet-gateway pull --ff-only`, then `npm ci --omit=dev` there) and run `node bin/t3-fleet-gateway.js doctor` from it: it opens the database, applies any new migration and prints a failure (`database_error` naming the migration; the database stays at the version before it). Do not go on until it passes.
4. Run `deploy/launchd/install.sh` from the clone, which loads the service again.

Run operator commands (`pair`, `jobs adopt`, `doctor`) from either checkout: they share the config and the data directory. A newer checkout may migrate the database on first use, and an older service then refuses to start against it (`database_error`: the schema is newer than the build), so update the service clone first.

Linux (systemd user unit): see the comments at the top of [`deploy/systemd/t3-fleet-gateway.service`](../deploy/systemd/t3-fleet-gateway.service).

On `SIGINT` or `SIGTERM` the gateway stops accepting connections, finishes in-flight requests (up to 10 seconds), lets the job engine finish its current tick, stops the renewal loop and closes the database. Startup command probes have their direct processes force-killed on cancellation and are not awaited; their completion cannot start renewal after shutdown. Job state is written as it changes, so nothing is lost; a launch interrupted by a crash is reconciled at the next start.

An uncaught exception or unhandled rejection in `serve` is logged as `process.fatal` (error name and code only), followed by the same graceful shutdown (bounded to 10 seconds), and the process exits `1` so the supervisor restarts it. One exception is ignored: Node 26.0's bundled HTTP client can throw `setTypeOfService EINVAL` outside the request when T3 resets a connection just as it is opened (T3 restarting, on macOS). That request fails like any other reset, and the gateway logs `process.transient_socket_error` and keeps running.

### A t3 that follows T3's updates

The service runs the pairing command (`t3 auth pairing create` by default) every time it renews a T3 credential (by default about every 25 days). T3 installs each version in its own directory under `~/.t3/runtime/versions/` and, when it updates itself, switches its own service to the new one. If `T3_BIN` (by default whatever `command -v t3` finds) is inside one of those directories, the gateway service's `PATH` keeps that version's directory: renewals go on running the old `t3` against the newer T3 server, and if that directory is ever removed, renewal fails with `pairing_command_failed` (shown by `hosts status`, `doctor` and `fleet_status`). The installer warns when `T3_BIN` is inside such a directory. A `t3` your shell finds through a symlink in a shared directory (such as `/opt/homebrew/bin`) is fine as long as T3's updates move the symlink.

T3 has no stable `t3` path today. One way to get one is a small wrapper that runs the version T3's own service uses, saved as `~/.local/bin/t3`. It reads `activeVersion` from T3's internal `runtime/service-state.json`, so check it again if a T3 update changes that file:

```sh
#!/bin/sh
# Run the T3 version that T3's service currently uses; keeps working after T3 updates itself.
state="${T3CODE_HOME:-$HOME/.t3}/runtime/service-state.json"
version=$(sed -n 's/.*"activeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$state" 2>/dev/null)
bin="${T3CODE_HOME:-$HOME/.t3}/runtime/versions/$version/t3"
[ -n "$version" ] && [ -x "$bin" ] || { echo "t3 wrapper: no active T3 version found in $state" >&2; exit 1; }
exec "$bin" "$@"
```

Make it executable (`chmod +x ~/.local/bin/t3`), check that `~/.local/bin/t3 --version` prints the version T3 runs, and install with `T3_BIN=$HOME/.local/bin/t3 deploy/launchd/install.sh`.

## Logs

`serve` writes JSON lines to standard output (launchd: `~/Library/Logs/t3-fleet-gateway/gateway.log` by default; systemd: `journalctl --user -u t3-fleet-gateway`). Set `T3FG_LOG_LEVEL=debug` for more detail. Useful events:

| Event | Meaning |
| --- | --- |
| `gateway.started`, `gateway.stopped` | Lifecycle |
| `oauth.client_registered`, `oauth.approval_granted`, `oauth.approval_denied` | Agent onboarding |
| `oauth.approval_repeated` | An approved form was submitted again (a double click, or Back and resubmit); `resent` says whether the same authorization response was still usable. Not a failure |
| `oauth.approval_failed`, `oauth.approval_throttled`, `oauth.registration_throttled` (warn) | Wrong codes; throttling engaged (see Throttles) |
| `oauth.token_issued`, `oauth.refresh_retry_accepted` | Token issue and rotation |
| `oauth.token_family_revoked` (warn) | Refresh token or code replay: a grant was revoked |
| `mcp.tool_call` | Tool name, client id, outcome, error code, duration |
| `mcp.unauthorized`, `mcp.origin_rejected` | Rejected `/mcp` requests |
| `host.enrollment_succeeded`, `host.enrollment_failed`, `host.renewal_due`, `host.not_enrolled` | T3 credentials |
| `host.pairing_preflight`, `host.pairing_preflight_failed` | Mint executable/probe startup diagnostics (and known resolution failures before renewal); host id and check code; renewal resolution failures also carry the bounded safe diagnostic shown by doctor |
| `project.model_missing` (warn) | At startup: a project has no model from the config and its T3 project has no default model, so T3 would refuse its launches; see `doctor` |
| `job.created`, `job.adopted`, `job.state_changed` | Job id, project, host, client id; the adopted job's first state; `from`, `to`, `reason`, `errorCode` |
| `job.launch_spec_unreadable` (warn) | The first read in this process of a job whose stored launch plan cannot be read, once per job (job id, host id and state, never the stored text). A queued job then fails with `database_error`; one with a thread carries on |
| `jobs.host_unreachable` (warn), `jobs.host_reachable` | The job engine lost or regained a host; jobs keep their state |
| `jobs.reconcile_failed`, `jobs.watch_failed`, `jobs.interrupt_failed`, `jobs.interrupt_deferred` (warn) | A T3 call for one job failed (job id, error code); the error is on the job and the call is retried next tick |
| `jobs.tick_failed`, `jobs.host_tick_failed` (error) | Unexpected engine errors (with an error code and, per host, the step); the next step still runs |
| `http.request` | Method, path (no query), status, duration; `listener: dashboard` for the dashboard's listener |
| `dashboard.started`, `dashboard.checks_run` | The dashboard listener (address and path); a manual check run (result counts) |
| `dashboard.request_refused` (warn) | A dashboard request refused: `reason` (`host_not_allowed`, `funnel`, `cross_site`, `origin_not_allowed`, `missing_api_header`, `content_type`) and status; never the host or origin |
| `process.transient_socket_error` (warn) | Node 26.0's `setTypeOfService EINVAL` after T3 reset a new connection; harmless (see Run as a service) |
| `process.fatal` (error) | An uncaught error (name and code): `serve` shuts down and exits `1`; `gateway.shutdown_timeout` if that took over 10 seconds |

Logs never contain tokens, codes, authorization headers, task text or message content.

## Live end-to-end check

`scripts/e2e-live.ts` checks a running gateway against a real T3 host the way an agent would. It is not part of `npm test`. It registers a client, gets approved for **Operate** with a code you mint, exchanges the code, calls `fleet_status`, then:

1. starts job A in a project with a tiny harmless task (reply `READY`, no commands, no file changes) and polls `work_feed` until it is `idle`;
2. checks with `work_status` that the job has a thread and that the excerpt of the worker's reply contains `READY`, sends a follow-up with `work_continue` (reply `DONE`), polls until `idle` again and checks that the new excerpt contains `DONE`;
3. starts job B with a long harmless task (count slowly to 200, no commands, no file changes), waits until it runs, cancels it with `work_cancel`, requires the outcome `cancel_requested` (an interrupt of a run still going), and waits until the watcher confirms `cancelled`. If job B had already finished when the cancel arrived, the script prints an `INFO` line, starts one replacement job B and cancels that; a second finished job fails the step;
4. cancels job A to leave nothing active.

These checks are what only a real T3 can confirm: that worker replies are recognised and read back, and that an interrupt stops a running worker. A job that reaches `failed` fails its step with the job's `lastError` code and message. The script prints one `PASS`/`FAIL`/`INFO` line per step with job ids, states, reasons and error codes only (never tokens, approval codes or worker text: it reports whether an excerpt contains the expected word, not the excerpt), ends with `E2E PASS` or `E2E FAIL`, and exits `0` or `1`.

Use a scratch project: each run leaves two T3 threads (three if job B was replaced) with their worktrees and branches. With the gateway running (`serve`) and the host enrolled:

```sh
t3-fleet-gateway pair                    # mint an approval code
T3FG_E2E_APPROVAL_CODE=XXXXX-XXXXX \
T3FG_E2E_PROJECT=pilot \
  node scripts/e2e-live.ts --config /path/to/config.json
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3FG_E2E_APPROVAL_CODE` | required | A code from `pair`; it is used once and never printed |
| `T3FG_E2E_PROJECT` | required | Explicit scratch project alias to run the jobs in |
| `T3FG_E2E_URL` | `publicUrl` | Gateway base URL, for example `http://127.0.0.1:3790` to bypass the tunnel |
| `T3FG_E2E_TIMEOUT_SECONDS` | `600` | How long to wait for each job transition |
| `T3FG_E2E_POLL_SECONDS` | `5` | Delay between `work_feed` polls |

`--config` (or `$T3FG_CONFIG`) is read for `publicUrl` only. If a job reaches `needs_input` (for example an approval under `approval-required`), the script says so and keeps waiting until the timeout, so you can approve it in T3. Each run registers a new agent client; remove old ones with `clients revoke`.

The lifecycle script also discovers the tool list, checks `work_list`, reads complete replies with `work_messages`, and reports successful tool coverage. It exercises eight of the nine tools; `work_respond` needs a real question fixture. A lifecycle pass does not qualify questions, approvals, failures, delegation or a hosted connector.

### Discovery smoke (issue #12)

The opt-in discovery feature has a bounded live smoke against a single fresh QA-only T3 instance with its own gateway data directory, credentials and a scratch git repository, driven through the public OAuth and MCP endpoints, with no access to any other gateway or T3 installation. It passed 28 of 28 checks at both the initial implementation head and the implementation with review fixes. The sanitized case table and the assumptions it rests on are in [evidence/discovery.md](evidence/discovery.md). It is not a live fleet or hosted-connector (Grok, Notion) qualification, and the harness is not part of this repository.

### Verified behavior

These results come from live runs against a real T3 server, using scratch projects only. Most runs used a separate gateway configuration and database; the Grok Bot check used temporary scratch aliases on a gateway that Grok Bot could reach, removed afterward. SDK and direct HTTP clients stood in for hosted connectors except where Grok Bot is named.

**Lifecycle.** The runs confirmed starting and following jobs, a standing coordinator's delegated child and the coordinator's automatic resumption, Read-scope refusal, exclusive feed paging and idempotent follow-ups.

**Questions.** T3 returned a Codex pending request ID longer than 200 characters, which the gateway's own input limit rejected. v0.1.4 removes that invented cap on the opaque ID and keeps non-empty validation, live job/request membership, and the separate answer, question-id and mutation-key limits. The original live question was then answered, and synthetic public text-only regressions fail on v0.1.3 and pass after the change. Retests covered all nine tools of that release together. A direct HTTP client using only MCP content text (structured output discarded) answered a real request ID of over 200 characters, read the completed reply and verified exclusive feed paging. Grok Bot, whose client reads text content only, read a real question and its options from `work_status` as plain text and answered through `work_respond` with the full request ID; the gateway's events recorded `needs_input` → `running` → `idle`. That exercises the actual Grok client's shared MCP question and answer path.

**Approvals.** A real Codex sample collected before the state-rule fix showed a brief `waiting` thread and run with zero pending requests and no approval item. v0.1.4 keeps that turn `running` rather than inventing an operator approval: the synthetic regression using that native shape fails before the fix and passes after it, and real question resumption after the fix showed no false approval. A genuine permission request approved in T3 was observed as `needs_input` with `waitingForApproval: true` and then `idle` with the flag cleared (`running` in between when the watcher sampled it); the exact scratch marker and the final worker reply were verified.

**Failed runs.** A refused TCP connection kept the provider retrying and did not produce a terminal failure. A QA-only loopback HTTP endpoint answering 401 produced an actual failed T3 run and the gateway's `t3_run_failed`; adopting its thread as a standing job kept it usable after another failed follow-up. A shell command that exits nonzero is not this fixture.

**SDK recovery.** Cutting only the test gateway's ingress for 70 seconds, with a 60-second access token, kept the saved credentials: reconnection refreshed without another approval and resumed the exclusive feed cursor. A proxy that dropped a completed `work_start` response showed that the SDK does not retry the POST automatically, and a manual retry with identical input and request ID returned the same job (`created: false`). These are SDK results.

**Not verified.** A hosted Notion job workflow, hosted-connector recovery after an outage and downstream T3 outage recovery have not been run; the SDK and direct HTTP results above do not claim them.

## Backup and restore

Everything is in the data directory. With the gateway stopped, copy the whole directory (keep its `0700`/`0600` permissions), or while running use SQLite's online backup:

```sh
sqlite3 ~/.local/share/t3-fleet-gateway/gateway.db ".backup '/path/to/backup/gateway.db'"
cp -p ~/.local/share/t3-fleet-gateway/gateway.key /path/to/backup/
```

Back up before updating the service to a version whose CHANGELOG lists a schema migration: the first start applies it, and an older version refuses the migrated database. Each migration runs in one transaction: if it fails, `serve` (or the command) stops with `database_error` naming the migration, and the database stays at the version before it. `could not run: another process is using the database (SQLITE_BUSY)` means another gateway process or CLI command held the database for more than the 5-second busy timeout: stop the service (and any other command using the data directory), then start again.

Treat backups as secrets: they contain T3 credentials. To restore, stop the gateway, put both files back in the data directory with mode `0600`, and start it. Without `gateway.key`, existing agent connections keep working but unused approval codes become invalid.

## Uninstall

1. Stop and remove the service (`deploy/launchd/install.sh --uninstall`, or `systemctl --user disable --now t3-fleet-gateway`).
2. Revoke the gateway's T3 sessions: in T3 under Settings → Connections, or `t3 auth session list --json` and `t3 auth session revoke <id>` for sessions labelled `t3-fleet-gateway (<host id>)`.
3. Remove the agent connection in each agent.
4. Delete the data directory, the config file and the logs.

## Precise bot notifications and recovery

Dashboard **Choose precise notifications** accepts optional comma-separated event, job and original-client
IDs when connecting. Blank fields preserve the current defaults. These filters intersect the selected
project/host; key replacement preserves them. Configuration supports the same filters and multiple
host/project targets. For bot-managed per-job subscriptions, provision a dedicated config connection
with `ownerClientId` and an explicit host ceiling (see [configuration](configuration.md#bot-owned-job-notifications)).

A bot uses these MCP calls with its normal gateway bearer grant:

```text
work_notifications({})
work_start({project: "pilot", task: "Inspect the change", requestId: "new-work-1"})
work_subscribe({connectionId: "bot-notices", jobId: "<returned-job-id>", events: ["idle", "failed"]})
work_replay({connectionId: "bot-notices", afterCursor: "0", limit: 200})
```

Subscribe immediately after starting; use `work_feed` to cover any event before the subscription was
saved. A dedicated subscription tool keeps existing `work_start` request IDs and retries unchanged.
Before resuming existing work, subscribe then call `work_continue`. `work_subscribe` with `remove: true`
removes future capture. Unknown, other-client and unauthorized connections/jobs return the same
`not_found`. Ownership alone does not grant host access: every connection host must be in the bot's
grants, preventing a narrowed token from reading aggregate state for a hidden host. An owner connection
only captures gateway-started jobs owned by that client, not standing or imported threads.

Dashboard Webhooks, `doctor`, `webhooks list` and `work_notifications` show last delivery success/failure,
failure streak, pending events, cumulative dead-lettered events and cumulative omitted events. A dead
letter is an event whose one-hour delivery window expired, including one that expired before any POST.
Successful delivery resets the streak; synthetic pings do not hide a failed delivery stream. Health
survives attempt-history pruning; older attempts remain subject to the existing 100-per-connection /
1,000-global metadata limits. Health starts unknown at upgrade, and route replacement resets it.

Operators can queue a bounded replay locally, without contacting receivers or applying config:

```sh
t3-fleet-gateway webhooks replay bot-notices --after 123 --limit 200
t3-fleet-gateway webhooks replay bot-notices --since 2026-01-15T12:00:00Z
```

Choose exactly one selector: `--after` is an exclusive decimal feed cursor, `--since` is an inclusive
ISO timestamp. Bot `work_replay` uses `afterCursor` or `since` with the same semantics. Follow `nextCursor`
while `hasMore`; if the pending queue is full, allow deliveries to drain before continuing. Each call
scans at most 200 archived events, skips pending/sending duplicates, and requeues delivered or expired
events with the original payload/eventId and a fresh retry window. Receivers must deduplicate eventId.
A repeated replay may send an already delivered event again; it does not create a new source event.

The private archive retains seven days or the newest 10,000 matching events per connection, whichever
is smaller. A full pending queue still archives bounded payloads; oversized payloads cannot be archived
and require feed catch-up. `retentionGap` reports a request before the known archive floor or retained
time window. No pre-upgrade/pre-connection snapshots are invented. Replacing/disabling/removing a route
invalidates its old archive and job bindings; bot subscriptions must be recreated for the new revision.
Use authorized `work_feed` for older gaps and the subscribe/start interval. Preserve its last contiguous
cursor independently: the maximum webhook/replay cursor is never proof that all fleet events were seen.
