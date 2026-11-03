# Troubleshooting

Start with the symptom below. A bot's public connection, its gateway sign-in and the gateway's private connection to T3 are separate hops; fixing one does not fix the others. [How bots reach the gateway](../README.md#how-bots-reach-the-gateway) shows the route.

Run these commands from the installed gateway checkout, using the same configuration, data directory and environment as the service. Every CLI command accepts `--config <path>` and `--data-dir <path>`; see [configuration](configuration.md). Commands that mint codes or tokens print secrets: enter those only in the intended approval page or private client settings, never in chat or an issue.

```sh
node bin/t3-fleet-gateway.js doctor
```

`doctor` checks the public URL, downstream hosts and credentials, project resolution and models, and (when enabled) the dashboard listener and public exposure. The dashboard's **Run checks** tests hosts and the public URL too, but does not check project/model resolution or execute command probes. Neither proves a cloud bot's own route or saved token works. Use the CLI when the dashboard itself is unavailable.

## Bot can't connect: fetch failed or timeouts

**Likely causes:** the gateway service is stopped, the public tunnel is down or points at the wrong listener, DNS/TLS is failing, or the bot's connection or routine has stopped retrying. A tunnel provider can drop its public route after a network change while the gateway remains healthy.

**Check:** run `doctor` and read the **public URL** result separately from the host results. **Run checks** in the private dashboard tests the same public metadata. A different-server or wrong-resource result means the public address is reaching the wrong destination or disagrees with `publicUrl`. Check the tunnel provider's route/status and the bot's own error and routine status.

**Fix:** restore the gateway service if stopped, or restart/re-register the tunnel with its provider if the public route was lost. The public HTTPS route must forward to the MCP listener (default `127.0.0.1:3790`), preserving the OAuth metadata and approval routes as well as `/mcp`. Configure the bot with `https://gateway.example.com/mcp` and set `publicUrl` to the matching origin. Never forward the dashboard listener. If operator checks pass but the bot still fails, investigate the bot's route and re-enable its routine if needed.

Keep the bot's saved credentials and feed cursor while fixing connectivity. A timeout alone is not evidence that sign-in expired. After access returns, resume `work_feed` from the saved `nextCursor`; retry uncertain work requests only with their original `requestId` and identical input. See [authentication and outage recovery](operations.md#authentication-and-outage-recovery).

## Approval page or sign-in problems

**Likely causes:** a broken public route, an expired/used approval code, throttling, an expired or revoked grant, a client holding an unusable token, or a browser-only client blocked by the OAuth CORS limitation.

**Check:** test the public route first, then inspect stored sign-in state:

```sh
node bin/t3-fleet-gateway.js clients list
node bin/t3-fleet-gateway.js clients diagnose <client-id>
node bin/t3-fleet-gateway.js throttle status
```

Diagnosis is an offline store read: `active` or `refreshable` describes gateway capability, not which token the bot saved. The dashboard's Clients view also shows observed successful MCP/refresh times; unknown or old times alone do not prove revocation.

**Fix:** start a fresh connection from the bot if its approval page is locked, and run `node bin/t3-fleet-gateway.js pair` for a new one-time code (15 minutes by default). Minting a code also lifts the global failed-code pause; `node bin/t3-fleet-gateway.js throttle reset` clears approval and registration throttles when needed. If the saved OAuth refresh token is usable, reconnect with the same token store; if it is unusable, complete a new approval. Static bearer tokens have no refresh: replace an expired/revoked one using [the bearer-token flow](operations.md#agents-that-only-take-a-bearer-token). Use a server-side or native MCP client for OAuth, rather than a browser-only client. See [connect an agent](operations.md#connect-an-agent) and [known limitations](security.md#known-limitations).

## Host unreachable

**Likely causes:** T3 is stopped, the gateway cannot reach the host over the private network, `t3Url` is wrong, or T3 rejects the stored credential. A working public tunnel does not establish this downstream connection.

**Check:** run `doctor` or dashboard **Run checks**, and:

```sh
node bin/t3-fleet-gateway.js hosts status
```

The dashboard's Hosts view shows the last contact and its age; refresh the checks before treating an old result as current. A rejected credential needs different recovery from a host that does not answer at all.

**Fix:** restore T3 and the private route from the gateway machine, or correct `t3Url`. If T3 answers but rejects the credential, use the renewal recovery below. Jobs retain their state during a host outage; the gateway backs off and resumes checking when the host returns. See [jobs](operations.md#jobs).

## Credential expiring or renewal failed

**Likely causes:** the pairing executable is missing from the service's `PATH`, a configured command points at an old T3 version, pairing was refused, or T3 was unreachable during renewal.

**Check:** `hosts status`, `doctor` and the dashboard's Hosts view show expiry, credential alerts and safe renewal diagnostics. `doctor` checks command resolution and runs a configured `mintPairingCodeProbe`; dashboard **Run checks** checks resolution without executing a command. Match the service's environment: a command found in your shell may be absent from its `PATH`.

**Fix:** repair the configured pairing command or private host route first. Prefer a T3 entrypoint that follows updates. Then use **Hosts → Re-pair → Confirm re-pair**, or:

```sh
node bin/t3-fleet-gateway.js hosts enroll main
```

Use the configured host ID in place of `main`. The old credential stays installed until a candidate verifies successfully. Re-pairing cannot repair a broken command. See [credential renewal](operations.md#credential-renewal) and [renewal command preflight](configuration.md#renewal-command-preflight).

## Job stuck in needs_input, unknown or queued

**Check:** open Jobs in the dashboard or list the ledger:

```sh
node bin/t3-fleet-gateway.js jobs list
node bin/t3-fleet-gateway.js jobs list --all
```

Ask the bot to read `work_status` and `fleet_status`, then open the job's T3 thread for questions, approvals and actual worker activity. The private dashboard deliberately omits question and message content.

| Symptom and likely cause | Fix |
| --- | --- |
| `needs_input`: a worker question or permission approval is waiting | Answer a question with `work_respond` or directly in T3. Permission approvals belong to you in T3; the bot cannot approve them. If questions are unreadable, retry the read or answer in T3. |
| `unknown`: a launch response was lost | Let reconciliation find the thread by its job marker. Inspect T3 before starting replacement work; do not create a second request just because the response was lost. With an answering host, the default reconciliation window is 10 minutes before `launch_not_confirmed`. |
| `queued`: the host is down/backing off or all launch slots are occupied | Restore host reachability, or let active jobs finish. `needs_input` and `unknown` jobs also occupy slots. Do not cancel unrelated work to free capacity without deciding it should stop. |
| `queued` with workspace selection enabled: a probe retry is deferred or another job holds the same root folder | Check the job's error and other work in that folder. Fix the probe if it fails; let the root holder settle before starting more work there. Never edit reservation rows manually. |

An `idle` job has ended its turn; read `work_messages` to learn the outcome. `waitingOnDelegatedWork: true` means its helpers are still working. See [job behavior and reconciliation](operations.md#jobs) and [workspace selection](configuration.md#workspace-probe).

## Webhooks not arriving

**Likely causes:** the receiver URL/key changed, the receiver is unavailable, filters exclude the event, the bot routine is disabled, or retries expired. Webhooks go outward from the gateway to the receiver; the bot's incoming MCP tunnel is a separate route.

**Check:** use the dashboard's Webhooks view and these commands:

```sh
node bin/t3-fleet-gateway.js webhooks list
node bin/t3-fleet-gateway.js webhooks attempts <connection-id> --limit 20
node bin/t3-fleet-gateway.js webhooks ping <connection-id>
```

The first two read safe stored diagnostics; `ping` sends synthetic content to the receiver. A successful test means the receiver accepted it, not that the bot routine ran. Check that routine separately. Filters intersect: every configured host, project, job and client filter must match. Bot-owned routes also need an owned job subscription.

**Fix:** for a dashboard-owned connection, use **Replace key** with both the current URL and full authorization header, then test. For a config-owned connection, update its private config/auth file and apply it through the service as described in [webhook setup](setup.md#configure-a-webhook-by-hand). Restore the receiver/routine and check event filters. Events whose one-hour delivery window expired need replay from retained history; see [precise notifications and recovery](operations.md#precise-bot-notifications-and-recovery). Keep `work_feed` catch-up as a fallback, and deduplicate replayed `eventId` values.

## Dashboard unreachable

**Likely causes:** the dashboard is disabled, the service is stopped, the private proxy is unavailable, `basePath` does not match the proxy mount, or `allowedHosts` does not match the browser's request host.

**Check:** run `doctor` for the local listener and public-exposure results. If the loopback listener answers but the browser cannot open the page, inspect the private route, path and host configuration. HTTP `421` means the host is not allowed; Funnel-marked traffic is refused. The dashboard has its own listener (default `127.0.0.1:3791`) and does not exist on `/mcp`.

**Fix:** enable/configure the dashboard and its separate private proxy using [operator dashboard setup](operations.md#operator-dashboard). Keep the proxy mount and `dashboard.basePath` identical, preserve the path, and list the browser's exact host in `dashboard.allowedHosts`. Listener changes require a gateway restart. Never fix access by pointing the public tunnel at the dashboard: anyone who can reach the dashboard can use its operator controls. If the public-exposure check fails, remove that public route immediately. See [the dashboard trust boundary](security.md#the-operator-dashboard).

## Project or model errors

**Likely causes:** an alias points at a missing/renamed T3 project, no model is configured, an explicit model is no longer advertised, discovery/launch policy forbids the request, or the bot lacks access to the host or project.

**Check:** run `doctor` for alias resolution and missing default models. The bot can read `fleet_status`; with discovery enabled, `fleet_projects` and `fleet_models` show the host's current allowed targets and model choices. Discovery is opt-in and checks the bot's host grant before reading anything. Use `clients diagnose <client-id>` for approved host access, or `clients scopes <client-id>` for scope details (prefix each with `node bin/t3-fleet-gateway.js`). Inspect project restrictions with `node bin/t3-fleet-gateway.js clients projects <client-id>`. An unauthorized host/job deliberately looks like `not_found`; a refused project start can return `insufficient_scope`.

**Fix:** correct the alias's exact project ID/title, configure a project `modelSelection` or host `defaultModelSelection`, or set a default model in T3. For an explicit selection, choose from the fresh host catalog; the gateway will not silently substitute a model. Respect `allowWorkStart`, runtime ceilings and discovery policy; approve the bot for the intended host if needed, and check its [project allowlist](operations.md#restricting-a-bot-to-projects) before changing project access. `launch_policy_changed` or `model_selection_invalid` at dispatch means the recorded request no longer fits current policy/catalog: correct it and start new work only after checking the old job's outcome. See [projects and models](configuration.md#projects) and [discovery](configuration.md#discovery).
