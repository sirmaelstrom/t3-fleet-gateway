# t3-fleet-gateway

[![CI](https://github.com/boundsj/t3-fleet-gateway/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/boundsj/t3-fleet-gateway/actions/workflows/check.yml)

**Let your bots start, follow and pick up coding work on your [T3 Code](https://github.com/pingdotgg/t3code) machines.**

The gateway is a small server you run next to T3 Code. It gives an outside bot, such as Grok Bot or a Notion agent, one sign-in and one MCP address for all your machines. (MCP is the protocol agents use to call tools.) Through it, a bot can:

- start work in your projects, or pick up a thread you started yourself in T3;
- read the worker's replies and answer its questions;
- get a webhook when a job finishes a turn, asks something or fails.

Every piece of work becomes a **job** with a stable ID and a history that survive lost connections and restarts. Each job is still an ordinary T3 thread you can open, read and type into.

It is for people who already run T3 Code on one or more always-on machines and want a bot to drive it, without handing that bot T3's own credentials.

![A bot connects to one gateway, which routes coding work to T3 projects on several machines.](docs/images/architecture.svg)

## T3 Code alone or with the gateway?

T3 Code already covers a lot of this on its own. As of [T3 v0.1.6](https://github.com/pingdotgg/t3code/releases/tag/v0.1.6):

- **Remote access is built in.** T3 Connect, LAN pairing, Tailscale HTTPS and SSH let you reach your machines from other devices. [Remote access](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/remote-access.md)
- **Outside agents get their own MCP endpoint.** Each machine serves HTTP MCP with OAuth sign-in. Claude Code, Codex, ChatGPT and other OAuth clients can launch, message, read, wait on and stop threads, and answer worker questions. Launches and sends take a retry key (`clientRequestId`). [Outside agents](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/outside-agents.md)
- **Machines can work together.** *Linked environments*, a Labs beta you turn on for both machines, lets agents on one machine launch and steer work on another; most tools take an `environmentId`. [Link another environment](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/remote-access.md#link-another-environment)
- **It tracks PRs and sends push alerts.** Workers link PRs to threads and can watch them. T3's mobile app gets an alert when an agent finishes, fails or needs you (this needs T3 Connect). [Linked pull requests](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/source-control.md#linked-pull-requests) · [Mobile notifications](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/mobile-notifications.md)

**You probably don't need the gateway if:**

- your agent is Claude Code, Codex, ChatGPT or another OAuth MCP client, and connecting it to each machine is fine;
- your agents run inside T3 and can reach your other machines through linked environments;
- push alerts in T3's app are the notifications you want;
- approving each agent again every 30 days is no trouble.

The gateway does not replace T3's remote access either: it is for bots, not for you on your phone.

**Where the gateway helps** is a bot that works unattended for weeks, across several machines, and needs waking up when something happens:

| | T3 Code alone (v0.1.6) | With the gateway |
| --- | --- | --- |
| Bot connection | An OAuth MCP endpoint on each machine | One OAuth MCP endpoint for every configured machine; bearer tokens for bots without OAuth, overlap rotation and per-token usage |
| More machines | Linked environments (Labs beta): turn on for both, link with a pairing code | Add the host to the config and enroll it once |
| Access per bot | Read only, or a runtime-mode ceiling that applies in every project | Read or Operate per machine, plus optional project allowlists per bot; model, runtime mode and "may start work" per project |
| Staying connected | Agent sign-ins and environment links last 30 days, then you approve or link again; no refresh | Bot sign-ins refresh (an unused refresh token expires after 90 days by default); the gateway renews its own T3 credentials and alerts you if renewal fails |
| Safe retries | `clientRequestId` on launch and send | A stored `requestId` on every start, follow-up, answer, adoption and settle; a lost launch is found again, never relaunched |
| Following work | Read or wait on one thread at a time | Jobs with stable IDs, and one `work_feed` with a cursor across all jobs and machines |
| Notifications | Push to T3's mobile app; webhooks only *into* T3, to trigger automations | Webhooks *out* to your bot, with filters, delivery health and replay |
| Pull requests | Link and watch PRs; a watch wakes the T3 agent | Each job's PRs and their state, readable by bots; optional PR webhooks |
| Threads you started by hand | Agents with access can read and message any thread | Adopt a thread so it gets a job ID, feed events, webhooks and a dashboard row |
| Operator view | T3's app on each machine; agents under Settings → Sharing & access | One private dashboard for hosts, bots, jobs and webhooks |

**Use both.** Work in T3 as usual while bots start, adopt and follow gateway jobs. Every job is an ordinary T3 thread you can open.

*T3 facts checked on 2026-10-31 against the v0.1.6 docs and tagged source (`2359643cffa6`). See the [gateway compatibility review](docs/evidence/t3-v0.1.6.md) for contract changes and verification limits. Sign-in lifetime: [outside agents, "Remove an agent"](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/outside-agents.md#remove-an-agent); no refresh grant: [`McpOAuth.ts`](https://github.com/pingdotgg/t3code/blob/v0.1.6/apps/server/src/auth/McpOAuth.ts#L490-L491); link lifetime: [link another environment](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/remote-access.md#link-another-environment); access levels: [outside agents, "Approve a sign-in"](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/outside-agents.md#approve-a-sign-in); inbound webhooks: [webhook automations](https://github.com/pingdotgg/t3code/blob/v0.1.6/docs/user/project-settings.md#webhook-automations).*

## What the gateway adds

### Pick up work you started in T3

A bot can take over a thread you started by hand in T3. It lists the project's threads with `fleet_threads`, then adopts one with `work_adopt`. The thread becomes a gateway job: the bot can read its history with `work_messages`, follow it in `work_feed`, send it follow-ups with `work_continue`, answer its questions with `work_respond` and settle it when you are done.

Adoption only reads from T3. It does not change the thread's model, runtime mode or workspace, uses no launch slot, and leaves the thread exactly where it is in T3. You keep typing into it whenever you like; the job records those turns too. `jobs release <jobId>` stops following it without touching T3.

Adoption is opt-in per bot. The host needs discovery turned on, and you grant the bot `threads:read` and `threads:control` on the gateway machine (step 4 of setup). Archived threads, delegated child threads and threads the gateway already follows cannot be adopted. [How adoption works](docs/design.md#external-thread-discovery-and-adoption).

For a long-running thread you want every bot to use, such as a coordinator, register it yourself as a **standing job** instead (see [Coordinator threads](#coordinator-threads)).

### One address for all your machines

Bots connect to one HTTPS endpoint, `https://<your gateway>/mcp`. The gateway connects to each T3 host for them, so adding a machine is a config entry and one `hosts enroll` command, not a new connection in every bot.

You approve each bot once with a one-time code on the gateway's approval page. Choose **Read** (follow work) or **Operate** (also start and steer it), on **All machines** or only **Selected machines**. Bots that take only a bearer token get one from `clients token`. Use `clients tokens <client id>` to inspect safe token IDs, creation, expiry, last use and recent tool call counts. Rotate with `clients rotate <client id> --token-id <id> --overlap 7d`, then update the bot privately before the old token expires. `clients revoke-token <client id> --token-id <id>` revokes one token immediately; `clients revoke <client id>` revokes them all. Bots never see T3's credentials. [Per-host grants](docs/design.md#per-host-grants).

Limit a bot to approved projects with `clients projects <client id> --project <alias> --project @<host>/<projectId>`. Repeat `--project` for each approved project; this replaces the whole list. It applies to every token of that client, including rotated tokens, and takes effect on the next request without a restart. Discovery, job feeds, attention lists, thread access and bot notifications stay inside the list and the bot's machine grants. No list keeps today's access; `--no-projects` denies all projects and `--all-projects` removes the restriction. [Project access](docs/design.md#per-client-project-access).

### How bots reach the gateway

Your bot lives in the cloud; your gateway lives on your machine and listens only on loopback. The bridge between them is a **public HTTPS tunnel**, such as Tailscale Funnel or Cloudflare Tunnel. That's the hosted bot's only way in: it cannot use your machine's loopback address or private network directly.

```mermaid
flowchart LR
  Bot["🤖 Hosted bot"] --> Tunnel["🌐 Public HTTPS tunnel"]
  subgraph Machine["🖥️ Your machine"]
    Gateway["🚪 Gateway (loopback)"]
    Dashboard["🎛️ Dashboard (separate loopback listener)"]
  end
  Tunnel --> Gateway
  Gateway -->|Private network| Hosts["🛠️ T3 hosts"]
  Operator["🧑‍💻 You"] -->|Private route only| Dashboard
```

The gateway talks to your T3 hosts over your private network. The dashboard gets its own private route and **never goes on the public tunnel**. Bots get the front door; you keep the control room.

If the tunnel goes down, bots lose access even while the gateway itself is healthy. `doctor` and the dashboard's **Run checks** test the public URL from the gateway machine; a pass there still needs a connection check from your bot. See [troubleshooting](docs/troubleshooting.md#bot-cant-connect-fetch-failed-or-timeouts) if the bridge is out.

### Jobs that survive lost connections

Bots work over flaky networks and retry. The gateway makes that safe:

- Every start, follow-up, answer, adoption and settle carries a `requestId`. A retry with the same ID and the same input returns the original result instead of starting a second job or sending the message twice.
- A launch whose response was lost is marked `unknown` and found again by its `[job:<id>]` title marker. It is never launched twice.
- `work_feed` returns events after a cursor. A bot that saves `nextCursor` misses nothing while it was away.
- Job state lives in a local SQLite database, so a gateway restart picks up where it left off.

### Bots answer the worker's questions

When a worker asks a question, the job shows `needs_input` and `work_status` includes the full question and its options, in plain text for bots that read only text. The bot answers with `work_respond`. Permission approvals (running a command, editing a file) stay with you in T3; the bot sees `waitingForApproval` and can tell you.

### A webhook when work needs you

Polling `work_feed` works on its own. Add a webhook and the gateway sends a small HTTPS notice when a job finishes a turn, needs input, fails, is cancelled or stops waiting on delegated work. Pull request opened/merged events are opt-in. The bot then reads the details through its normal MCP connection.

To connect a Grok Bot routine, paste its URL and header into the private dashboard and click **Connect & Test**. Filters narrow a connection to projects, hosts, jobs, events or the bot that started the job. On a connection you set up for one bot, that bot can subscribe its own jobs (`work_subscribe`), check delivery health (`work_notifications`) and replay missed notices from a seven-day archive (`work_replay`). [Bot notifications and recovery](docs/operations.md#precise-bot-notifications-and-recovery).

### Coordinator threads

If you keep a long-lived T3 thread that plans and delegates to child threads, register it as a standing job with `jobs adopt <alias> <threadId>`. Bots find it in `fleet_status` and send it work with `work_continue`. Set `allowWorkStart: false` on the project and it becomes the only way in: `work_start` there is refused with a pointer to the coordinator.

While its helpers run, the job is `idle` with `waitingOnDelegatedWork: true`, so the bot knows to wait instead of sending more instructions. When T3 starts the coordinator's next turn, the job goes back to `running`. [Standing jobs](docs/operations.md#standing-jobs).

### Project rules in one place

Bots target short **project aliases** such as `pilot`, not T3 project IDs. Each alias carries your rules: which host and T3 project, the model, the runtime mode (whether workers must ask before acting), the base branch and whether bots may start new work there. New jobs get a fresh Git worktree and branch by default. You can also opt in to a scratch workspace for work with no project, work directly in the project folder, and let bots browse T3 projects and models.

`standingInstructions` adds your shared rules, such as "run the checks before handing back", to the first message of every new job. [Standing instructions](#standing-instructions-for-workers).

### Pull requests per job

When a worker links its PR in T3 (`link_pull_request`), `work_status` and `work_list` show the job's PRs and their open or merged state, and the dashboard shows a badge. The gateway refreshes them about once a minute while it follows the job. [PR tracking limits](docs/design.md#job-pull-request-snapshots).

### Host access that keeps working

T3 credentials expire. The gateway renews its own before they do, using the pairing command you configured, and keeps the old one until the new one is verified. If renewal fails, it raises a credential alert on the dashboard and through webhook connections that include credential events (new connections do by default). **Hosts → Re-pair** in the dashboard then runs the pairing flow again after you confirm it. No pairing code is shown or pasted. [Credential renewal](docs/operations.md#credential-renewal).

### A private dashboard

![The private dashboard showing fictional hosts, clients and jobs.](docs/images/dashboard.png)

*The real dashboard with a synthetic demo fleet.*

One page for the operator: which hosts answer, which bots connected and when, jobs waiting on you, credential problems and webhook delivery health. **Run checks** tests every host and the public URL on demand. It also connects webhook receivers, confirms host re-pair and settles quiet jobs. It runs on its own loopback port, published only on your private network. Anyone who can reach it can use those controls. [Dashboard setup](docs/operations.md#operator-dashboard).

## Set up with prompts

### Before you start

- An always-on machine with **Node.js 24.22.1 or a later 24.x, or 26.12.1 or newer**. Older releases lack the required [TLS protection](docs/security.md#compromised-emudhra-intermediates).
- T3 Code running on each machine you want to use, and a `t3` CLI that can create pairing codes for it.
- A public HTTPS tunnel, such as Tailscale Funnel or Cloudflare Tunnel: [how bots reach the gateway](#how-bots-reach-the-gateway).
- For the dashboard, a separate private route such as Tailscale Serve. Never put the dashboard on the public tunnel.

The gateway runs from a Git checkout; it is not published to npm. There is no build step.

### 1. Install: hand this to your coding agent

Run a coding agent (T3 Code itself works) on the machine that will host the gateway, fill in the `<…>` parts and paste:

```text
Install t3-fleet-gateway (https://github.com/boundsj/t3-fleet-gateway) on
this machine as a background service. Read its README, docs/setup.md,
docs/configuration.md and docs/operations.md ("Run as a service") first,
and follow them.

- Check that Node is 24.22.1+ on 24.x or 26.12.1+. If not, stop and tell me.
- Use a clone dedicated to the service, then run `npm ci --omit=dev` there.
- Create the private config ~/.config/t3-fleet-gateway/config.json (mode
  600) from config.example.json:
  - publicUrl: <https://gateway.example.com>
  - hosts (id, T3 URL, how to reach it): <main: this machine>
  - project aliases (alias → exact T3 project title): <pilot → pilot>
  - Keep runtimeMode "approval-required" and discovery off.
  - Make sure every project has a model: replace the example model ID,
    or remove it if the T3 project has its own default.
- Enroll each host with `node bin/t3-fleet-gateway.js hosts enroll <id>`.
- Install the service: deploy/launchd/install.sh on macOS, the systemd
  user unit on Linux. Use a `t3` command that follows T3's updates.
- Point <my HTTPS tunnel> at the MCP listener, 127.0.0.1:3790.
- Optional: enable the dashboard on its own loopback port and publish it
  only on <my private network>, never on the public tunnel.
- Run `node bin/t3-fleet-gateway.js doctor` and fix every FAIL.

Don't run `pair` or `clients token`; I will. Never print credentials.
When done, give me the MCP URL, the dashboard URL and the doctor result.
```

`doctor` checks the config, each host's credential and reachability, that each project resolves and has a model, and that the public URL reaches this gateway. It cannot prove your hosted bot's own route works; the next step does that.

### 2. Connect your bot

1. Add `https://<your gateway>/mcp` to the bot's remote MCP settings. The bot sends you to the gateway's approval page.
2. On the gateway machine, from the service checkout, create a one-time code (valid 15 minutes):

   ```sh
   node bin/t3-fleet-gateway.js pair
   ```

3. Enter it on the approval page. Choose **Read** or **Operate**, and **All machines** or **Selected machines**.

If the bot accepts only a bearer token, run `node bin/t3-fleet-gateway.js clients token --name <bot> --access operate --hosts <host ids> --ttl 90d` instead and paste the printed token privately into the bot's connection settings. It is shown once and has no refresh. [Bearer tokens](docs/operations.md#agents-that-only-take-a-bearer-token).

Then give the bot its working rules:

```text
You're connected to my T3 fleet gateway. Call fleet_status and tell me
which machines, projects and standing jobs you can use.

When I give you coding work:
- Start it with work_start in the right project and a new requestId. If
  a call fails or times out, retry with the same requestId and the same
  input. Never start a second job just because a call failed.
- Keep the job ID and T3 link. Follow the job with work_status and
  work_feed (save nextCursor), and read replies in full with work_messages.
- If the worker asks a question, answer it with work_respond when the
  answer is clear; otherwise ask me. Permission approvals are mine, in T3.
- "idle" means the turn ended, not that the task worked: read the reply.
  If waitingOnDelegatedWork is true, wait; its helpers are still working.
- Don't merge, deploy or cancel anything unless I ask.
```

Never paste tokens or pairing codes into a chat.

### 3. Wake the bot with a webhook

For Grok Bot, create the routine first. In the conversation that should get updates:

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

Then, in the private dashboard:

1. Open **Connect Grok Bot**.
2. Paste the routine's **POST to** value into **Webhook URL** and its full **header** into **Full authorization header**. The header already includes the key.
3. Choose a project and click **Connect & Test**.

"Test accepted" means the receiver took the request. Check the bot conversation to see that the routine ran. If you recreate the routine, its URL and key can both change: use **Replace key** with both. Other HTTPS receivers work the same way. No dashboard? [Configure a webhook by hand](docs/setup.md#configure-a-webhook-by-hand).

### 4. Let the bot adopt T3 threads (optional)

Hand this to your coding agent on the gateway machine:

```text
In my t3-fleet-gateway service config, set discovery.enabled to true for
host <main> and leave discovery.allowWorkStart false. Restart the service
as docs/operations.md "Run as a service" describes and run doctor.
Then, from the service checkout, run `node bin/t3-fleet-gateway.js clients
list`, find the client named <bot name>, and grant it both thread scopes:
`clients grant <client id> --scope threads:read --scope threads:control`.
Show me `clients scopes <client id>`.
```

Discovery here lets bots browse the host's T3 projects and models; with `allowWorkStart` false they still start work only in your aliases. Thread scopes take effect on the bot's next request, with no new token. Remove them with `clients ungrant`.

### Prefer to do it by hand?

Every step above is in the [manual setup guide](docs/setup.md), with more on the service, the dashboard and webhooks.

## Try it

A first job:

```text
In project pilot, check the README for broken local links and propose
the smallest fix. Run the relevant checks and bring me the result for
review. Don't merge or deploy anything.
```

The gateway starts a T3 thread in a fresh worktree and branch, and follows it. Open its link to watch or join in.

Picking up your own work (needs step 4):

```text
I started a thread in T3 in project pilot on main called "<title>".
Find it with fleet_projects and fleet_threads, adopt it with work_adopt
and a new requestId, then summarize where it stands from work_status and
work_messages. Follow it from now on and tell me when it needs me.
```

When you've reviewed a job, the bot can `work_settle` it, which parks the T3 thread without archiving it. An idle settled job can still be continued later. [Settlement](docs/design.md#thread-settlement).

## How it fits together

| Term | Meaning |
| --- | --- |
| Host | A T3 Code server on one machine. The gateway connects to each configured host on its own. |
| Project alias | A short name, such as `pilot`, for a host and T3 project, with your launch rules. |
| Client | A bot or agent connected to the gateway, with its own access grant. |
| Job | The gateway's record of one T3 thread: stable ID, link, state and event history. |
| Worker | The agent running inside the T3 thread. Your bot gives it work and reads its replies. |
| Webhook | An HTTPS notice that wakes a bot. The bot then reads details over MCP. |

### Tools your bot uses

| Task | MCP tools |
| --- | --- |
| See hosts, projects and models | `fleet_status`, `fleet_projects`, `fleet_models` |
| Start work | `work_start` |
| Read state, history and replies | `work_status`, `work_list`, `work_feed`, `work_messages` |
| Follow up, answer questions or interrupt | `work_continue`, `work_respond`, `work_cancel` |
| Settle a quiet thread after review | `work_settle` |
| Find and adopt threads started in T3 | `fleet_threads`, `work_adopt` |
| Manage its own notifications | `work_notifications`, `work_subscribe`, `work_replay` |

`fleet_projects`, `fleet_models` and `fleet_threads` need discovery on the host; the thread tools also need the thread scopes. Schemas and limits: [design reference](docs/design.md#tools).

## Configuration: choose what to enable

Start from [config.example.json](config.example.json). The default location is `~/.config/t3-fleet-gateway/config.json`; keep it and the data directory private. Config changes take effect when the service restarts. Dashboard webhook connections and client scope changes apply live.

| Option | Use it for |
| --- | --- |
| [Projects, models and runtime modes](docs/configuration.md#projects) | Alias destinations, model defaults, whether bots may start work and whether workers ask for approval. |
| [Discovery](docs/configuration.md#discovery) | Let bots browse a host's T3 projects and models. Launching into projects without an alias is a separate opt-in; aliases keep their rules. |
| [Scratch default](docs/configuration.md#no-named-project) | Work that names a machine but no project. Needs an explicitly pinned scratch alias; an unknown project never falls back to scratch. |
| [Workspace selection](docs/configuration.md#workspace-probe) | Work in the project's own folder or a worktree. Folder work edits the existing checkout directly; one gateway job per folder. |
| [Standing jobs](docs/operations.md#standing-jobs) | Register a coordinator thread you already use and keep talking to it through one job ID. |
| [Thread adoption](docs/design.md#external-thread-discovery-and-adoption) | Let selected bots find and adopt threads started in T3 (`threads:read`, `threads:control`). |
| [Attachments](docs/attachments.md) | Send base64 images and files with `work_start` or `work_continue`. File URLs are not supported. |
| [Renewal](docs/configuration.md#renewal) | Credential renewal timing and alert thresholds. |

### Standing instructions for workers

Use the optional top-level `standingInstructions` to give every newly launched worker shared rules. A partial config snippet:

```json
{
  "standingInstructions": "Run the relevant checks and describe the result before handing work back."
}
```

The text is added to the first message of each new job, including scratch and discovered-project jobs. It is not added to follow-ups or to adopted threads. These are instructions in the prompt, not enforced limits. [Limits and lifecycle](docs/configuration.md#standinginstructions).

## Guides and troubleshooting

| I want to… | Read this |
| --- | --- |
| Install by hand, run as a service or connect a client | [Setup](docs/setup.md) |
| Fix a connection, sign-in, host, job or notification problem | [Troubleshooting](docs/troubleshooting.md) |
| Look up every configuration field | [Configuration](docs/configuration.md) |
| Diagnose connections, recover access, update or back up | [Operations](docs/operations.md) |
| Understand credentials, access and trust boundaries | [Security](docs/security.md) |
| Read tool contracts and implementation details | [Design](docs/design.md) |
| See release changes | [Changelog](CHANGELOG.md) · [GitHub releases](https://github.com/boundsj/t3-fleet-gateway/releases) |

Start connection trouble with `doctor`, then `clients diagnose <client-id>` for the bot's stored sign-in state. A valid grant does not prove that a hosted bot saved its token or that its routine is still enabled. [Authentication and outage recovery](docs/operations.md#authentication-and-outage-recovery).

Server-side and native MCP clients are supported. Browser-only clients cannot finish the gateway's OAuth sign-in, because its OAuth endpoints do not allow cross-origin requests (CORS). [Known limitations](docs/security.md#known-limitations). Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run check             # typecheck, tests with fake T3, and privacy checks
npm run dashboard:demo    # dashboard with a synthetic fleet
npm run webhooks:smoke    # isolated HTTPS, retry and crash checks; needs OpenSSL
```

The [compatibility check](docs/operations.md#developer-compatibility-check) is a separate, manual read-only probe against T3, not part of the test suite. Start contributing with [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
