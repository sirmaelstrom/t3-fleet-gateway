# Manual setup

Follow these steps yourself or give them to a coding agent on the gateway machine. They expand the [README's prompt-based setup](../README.md#set-up-with-prompts). See [configuration](configuration.md) for fields and [operations](operations.md) for maintenance and recovery.

Having trouble along the way? Use the [symptom-based troubleshooting guide](troubleshooting.md).

## Before you start

- Node.js 24.22.1 or a later 24.x, or 26.12.1 or newer.
- A running T3 Code server and a `t3` CLI that can mint pairing codes for it.
- A machine that stays on while agents work. macOS and Linux service templates are included.
- An HTTPS tunnel to the gateway for cloud clients. The gateway listens on loopback; Tailscale Funnel, Cloudflare Tunnel or another tunnel can carry its public MCP endpoint.
- A separate private route if you enable the operator dashboard. Use a tailnet-only proxy such as Tailscale Serve for that listener, never a public tunnel.

Node runs TypeScript directly from a checkout; there is no build step or npm release. Give the service its own clone so development edits cannot change what runs at the next service restart.

## Install and configure

```sh
git clone https://github.com/boundsj/t3-fleet-gateway.git
cd t3-fleet-gateway
npm ci --omit=dev

mkdir -p ~/.config/t3-fleet-gateway
cp config.example.json ~/.config/t3-fleet-gateway/config.json
chmod 600 ~/.config/t3-fleet-gateway/config.json
```

Edit that private config using [the configuration reference](configuration.md):

1. Set `publicUrl` to the public HTTPS origin your tunnel will serve.
2. Configure each T3 host and its pairing command. The host's `access` sets the highest runtime mode its projects may use.
3. Add project aliases pointing to the host and exact T3 project ID or title. Projects default to `approval-required`: workers wait for your approval in T3 when necessary.
4. Ensure each project has a model, either in the gateway project entry, its host default or the T3 project's own default. `doctor` catches a missing default.

Keep discovery off unless you want agents to browse T3 projects and models beyond the configured aliases. Launching into unconfigured projects needs a separate opt-in. See [discovery](configuration.md#discovery).

## Enroll and start

For each configured host, enroll it by ID:

```sh
node bin/t3-fleet-gateway.js hosts enroll main
```

The gateway verifies the new T3 credential before storing it and renews it before expiry. It never passes that credential to agent clients.

Point your HTTPS tunnel at the MCP listener, default `127.0.0.1:3790`. Start the gateway:

```sh
# macOS: install the service from its dedicated checkout
deploy/launchd/install.sh

# Or run in the foreground
node bin/t3-fleet-gateway.js serve
```

For Linux, use [the systemd unit](../deploy/systemd/t3-fleet-gateway.service). Full service instructions, environment overrides and the update order are in [Run as a service](operations.md#run-as-a-service).

On macOS, use a `t3` entrypoint that follows T3's updates. A path under `~/.t3/runtime/versions/` pins renewal to that old CLI version. See [A t3 that follows T3's updates](operations.md#a-t3-that-follows-t3s-updates) and the installer's `T3_BIN` option.

Once the service and tunnel are running:

```sh
node bin/t3-fleet-gateway.js doctor
```

Resolve failures before connecting an agent. The public URL check verifies that the tunnel reaches this gateway; downstream checks verify T3 separately. An operator-side pass does not prove the cloud connector can reach it, so the next step includes a client check.

## Connect an agent

Add `https://<your public URL>/mcp` in the client's remote MCP settings. For OAuth clients such as Grok Bot, mint an approval code on the gateway machine:

```sh
node bin/t3-fleet-gateway.js pair
```

Enter it on the gateway's approval page. Codes work once and expire after 15 minutes by default. Choose **Read** to follow work or **Operate** to start and steer it. **All machines** includes hosts added later; **Selected machines** limits the grant to the selected hosts.

For a client that accepts only a bearer token, use:

```sh
node bin/t3-fleet-gateway.js clients token --name <client-name> --access read --hosts <host-ids> --ttl 90d
```

Copy the printed token privately into the connector's bearer-token setting. Use `--access operate` when it needs to start or steer work. The token is printed once and stored by the gateway only as a hash; it has no refresh flow. See [bearer clients](operations.md#agents-that-only-take-a-bearer-token) for expiry and revocation.

Ask the client to call `fleet_status`, then start a small job or read an existing standing job. Each new job has a `[job:<id>]` title marker in T3 and, in a named project, a separate worktree and branch (a machine's scratch alias, if you configured one, uses T3's scratch workspace instead; see [configuration](configuration.md#no-named-project)).

To inspect or disconnect a client:

```sh
node bin/t3-fleet-gateway.js clients list
node bin/t3-fleet-gateway.js clients diagnose <client-id>
node bin/t3-fleet-gateway.js clients revoke <client-id>
```

A network outage and expired credentials are different problems. Keep the client's saved OAuth credentials and `work_feed.nextCursor` while restoring connectivity. Follow [authentication and outage recovery](operations.md#authentication-and-outage-recovery); longer token lifetimes do not restart a disabled bot routine.

## Let a bot adopt T3 threads

To let a connected bot find and adopt threads you started directly in T3 (`fleet_threads`, `work_adopt`), turn on discovery for that host and restart the service. Leave `discovery.allowWorkStart` false unless bots should also launch into T3 projects that have no alias:

```json
"discovery": { "enabled": true, "allowWorkStart": false }
```

Then grant the bot both thread scopes:

```sh
node bin/t3-fleet-gateway.js clients list
node bin/t3-fleet-gateway.js clients grant <client-id> --scope threads:read --scope threads:control
node bin/t3-fleet-gateway.js clients scopes <client-id>
```

The change applies on the bot's next request with its existing token. `clients ungrant <client-id> --scope …` removes it. See [external thread discovery and adoption](design.md#external-thread-discovery-and-adoption).

## Add the private dashboard

Enable `dashboard` on a separate loopback port, set its mount path and allowed browser host, and publish that path through a private tailnet proxy. [The dashboard instructions](operations.md#operator-dashboard) include the Tailscale commands and exposure checks. Do not point the public MCP tunnel at this listener.

First, create a routine in the bot conversation that should receive updates. For Grok Bot, try:

```text
Create a webhook-triggered routine for T3 gateway updates. For type
"ping", acknowledge the connection test; it has no job ID. For job
events, deduplicate by eventId, call work_status for jobId, and read
work_messages when needed. Report a short status update here.

For this first test, only report: don't start, change or cancel work.
If waitingOnDelegatedWork is true, say the coordinator is still waiting
on its helpers. Keep scheduled work_feed catch-up as a fallback.

Give me the clickable Webhook URL, Webhook key and Authorization header
links that open this routine's private fields. Do not print the actual
URL, key or header value in chat.
```

The private links open the routine panel. If the bot does not supply them, ask explicitly for links to those fields, without printing their values. Copy **POST to** into the dashboard's **Webhook URL** and **header** into **Full authorization header**. The full header already includes the key. Open **Connect Grok Bot**, choose a project, then click **Connect & Test**. See [notification filters and recovery](operations.md#precise-bot-notifications-and-recovery).

Recreating a routine or rotating credentials can change its URL too. Copy both fields again when replacing the connection.

## Configure a webhook by hand

The dashboard handles this for the quick connection flow. Operators managing config directly can still use any trusted HTTPS receiver with an authentication header. Put the complete header value in an owned, regular `0600` file inside the gateway's private data directory. For `Authorization`, that value includes `Bearer ` when the receiver expects it. Use a private editor or stdin, not a command-line argument or chat.

Add a subscription to your private config. Every value below is a placeholder:

```json
"webhooks": {
  "subscriptions": [{
    "id": "routine",
    "enabled": true,
    "url": "https://receiver.example/routines/REPLACE_WITH_ROUTINE_URL",
    "auth": { "header": "Authorization", "secretFile": "routine.key" },
    "projects": ["pilot"],
    "hosts": ["main"],
    "events": ["needs_input", "idle", "failed", "cancelled", "delegated_work_ended"],
    "excerptChars": 0
  }]
}
```

Test it with a synthetic ping, then restart the service to apply a manual configuration change:

```sh
node bin/t3-fleet-gateway.js webhooks ping routine
node bin/t3-fleet-gateway.js webhooks list
node bin/t3-fleet-gateway.js webhooks attempts routine --limit 20
```

A ping creates no job and contains no worker content. Its acceptance confirms delivery, not completion of the receiver's routine. Check the bot's conversation too.

Keep the config, data directory and backups private: webhook URLs and header values can grant access. Excerpts stay off by default. A subscription does not replay history, and retries may produce duplicate or out-of-order arrivals, so receivers deduplicate `eventId` and retain feed catch-up. See [configuration](configuration.md#webhooks), [delivery semantics](design.md#outbound-job-webhooks) and [security](security.md#outbound-webhooks).

## Next steps

- [Standing jobs](operations.md#standing-jobs): connect a bot to a coordinator thread you already use.
- [Run as a service](operations.md#run-as-a-service): update deliberately and retain the previous data for rollback.
- [Backup and restore](operations.md#backup-and-restore): protect jobs, credentials and agent grants.
- [Uninstall](operations.md#uninstall): stop the service and revoke its access.
