/**
 * A synthetic fleet for the operator dashboard: a real gateway (its own temporary data directory, dashboard on) in front
 * of fake T3 hosts, with fictional clients and jobs driven through the gateway's public paths: OAuth sign-in and MCP
 * tool calls for agents, operator tokens and adoption for the operator, and the fake T3's thread model for workers.
 * Nothing here contacts a real T3, a real connector or the network beyond loopback, and every name is fictional.
 *
 * Used by scripts/dashboard-demo.ts (screenshots, browser checks) and test/dashboard-demo.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect as tcpConnect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseConfig } from '../../src/config.ts';
import { pkceChallenge, randomToken } from '../../src/crypto.ts';
import { startGateway, type RunningGateway } from '../../src/gateway.ts';
import { createLogger, silentLogger, type Logger } from '../../src/log.ts';
import { scopesForGrant } from '../../src/oauth/scopes.ts';
import { DAY, HOUR, MINUTE } from '../../src/time.ts';
import { startFakeT3, type FakeT3 } from '../../test/helpers/fakeT3.ts';

export const SCENARIOS = ['mixed', 'healthy', 'host-down', 'auth-issue', 'empty'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const SCENARIO_NOTES: Record<Scenario, string> = {
  mixed: 'A lived-in fleet: one host down, an approval and a question waiting, a failed job, a coordinator waiting on delegated work, a client never observed and a renewal failure.',
  healthy: 'Every host answering, every client seen recently, work running and idle, nothing waiting.',
  'host-down': 'Healthy, except the SSH-tunnelled host stopped answering after work was sent to it.',
  'auth-issue': 'Healthy hosts; one client lost its grant to token reuse and a bearer token expires soon.',
  empty: 'A fresh install: hosts enrolled, no clients, no jobs, no checks run.',
};

export interface DemoFleet {
  gateway: RunningGateway;
  dashboardUrl: string;
  mcpUrl: string;
  fakes: Record<string, FakeT3>;
  webhookReceiver: DemoWebhookReceiver | null;
  close(): Promise<void>;
}

export interface DemoOptions {
  scenario: Scenario;
  /** Dashboard port; 0 picks a free one. */
  dashboardPort?: number;
  basePath?: string;
  badge?: string | null;
  logger?: Logger;
  /** Leave the job engine on its timer afterwards (the interactive demo); tests drive it by hand. */
  runEngine?: boolean;
  /** A local synthetic receiver, for exercising the setup form without a real bot or key. */
  webhookReceiver?: boolean;
}

export interface DemoWebhookReceiver {
  acceptUrl: string;
  rejectUrl: string;
  timeoutUrl: string;
  authHeader: string;
  /** Counts only; never retains request headers or payloads. */
  counts: { accepted: number; rejected: number; stalled: number };
  close(): Promise<void>;
}

async function startDemoWebhookReceiver(): Promise<DemoWebhookReceiver> {
  const counts = { accepted: 0, rejected: 0, stalled: 0 };
  const server = createHttpServer((request, response) => {
    request.resume();
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    if (request.headers.authorization !== 'Bearer demo-only-key' || request.url === '/reject') {
      counts.rejected += 1;
      response.writeHead(401).end();
      return;
    }
    if (request.url === '/timeout') { counts.stalled += 1; return; }
    if (request.url !== '/accept') { response.writeHead(404).end(); return; }
    counts.accepted += 1;
    response.writeHead(202).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    acceptUrl: `${baseUrl}/accept`, rejectUrl: `${baseUrl}/reject`, timeoutUrl: `${baseUrl}/timeout`,
    authHeader: 'Authorization: Bearer demo-only-key', counts,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

const CALLBACKS = {
  grok: 'https://connectors.example.com/oauth/callback',
  muse: 'https://muse.example.org/mcp/callback',
} as const;

/**
 * The public URL: a loopback forwarder that holds its port (never released and bound again; AGENTS.md) in front of the
 * MCP listener, which takes a port of its own. The dashboard's public URL check then really reaches this gateway.
 */
async function frontDoor(): Promise<{ port: number; forwardTo(port: number): void; close(): Promise<void> }> {
  let target = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const upstream = tcpConnect(target, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    forwardTo: (port) => { target = port; },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Agent {
  clientId: string;
  refreshToken: string;
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Register, approve with a minted code and exchange it, as a hosted OAuth connector does. */
async function signIn(baseUrl: string, mint: () => string, name: string, callback: string, access: 'read' | 'operate', hosts: 'all' | string[]) {
  const registered = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [callback] }),
  });
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = randomToken(48);
  const authorize = new URL(`${baseUrl}/oauth/authorize`);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: callback, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', state: 'demo' })) {
    authorize.searchParams.set(key, value);
  }
  const html = await (await fetch(authorize)).text();
  const form = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    form.set(match[1]!, match[2]!.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  }
  form.set('approval_code', mint());
  form.set('decision', 'approve');
  form.set('access', access);
  form.set('hosts_mode', hosts === 'all' ? 'all' : 'selected');
  if (hosts !== 'all') for (const host of hosts) form.append('host', host);
  const answer = await (await fetch(`${baseUrl}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).text();
  const target = /<a href="([^"]*)">Continue to /.exec(answer)?.[1]?.replaceAll('&amp;', '&');
  const code = target ? new URL(target).searchParams.get('code') : null;
  if (!code) throw new Error(`demo sign-in for ${name} was not approved`);
  const tokens = await (await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: callback, code_verifier: verifier }),
  })).json() as { access_token: string; refresh_token: string };
  return { clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

async function connect(baseUrl: string, clientId: string, token: string, refreshToken = ''): Promise<Agent> {
  const client = new Client({ name: 'demo-agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: { token: async () => token } }));
  return {
    clientId,
    refreshToken,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`demo call ${name} failed: ${JSON.stringify(result.content).slice(0, 300)}`);
      return result.structuredContent as Record<string, unknown>;
    },
    close: () => client.close(),
  };
}

async function refresh(baseUrl: string, clientId: string, refreshToken: string): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
  });
}

/** Start the fleet for `scenario`. Times are spread over the last hours by running the gateway on a clock that catches up. */
export async function startDemoFleet(options: DemoOptions): Promise<DemoFleet> {
  const { scenario } = options;
  const fakes = {
    studio: await startFakeT3({ serverVersion: '0.9.4', projectCount: 4 }),
    forge: await startFakeT3({ serverVersion: '0.9.4', projectCount: 3 }),
    // In the mixed fleet the lab host's credential is near its end and its renewal is refused.
    lab: await startFakeT3({ serverVersion: '0.9.2', projectCount: 2, ...(scenario === 'mixed' ? { tokenLifetimeSeconds: 3 * 86400 } : {}) }),
  };
  let offset = scenario === 'empty' ? -40 * MINUTE : -8 * HOUR;
  const clock = () => Date.now() + offset;
  const advance = (ms: number) => {
    offset = Math.min(0, offset + ms);
  };
  const door = await frontDoor();
  const mcpUrl = `http://127.0.0.1:${door.port}`;
  const config = parseConfig({
    publicUrl: mcpUrl,
    listen: { host: '127.0.0.1', port: door.port },
    hosts: [
      { id: 'studio', label: 'Studio Mac mini', transportNote: 'Same machine', t3Url: fakes.studio.url, mintPairingCode: fakes.studio.mintCommand(), access: 'full-access', maxConcurrentJobs: 3,
        discovery: { enabled: true, allowWorkStart: false } },
      { id: 'forge', label: 'Forge workstation', transportNote: 'SSH tunnel', t3Url: fakes.forge.url, mintPairingCode: fakes.forge.mintCommand(), access: 'full-access', maxConcurrentJobs: 2,
        discovery: { enabled: true, allowWorkStart: true, runtimeMode: 'approval-required' } },
      { id: 'lab', label: 'Lab VM', transportNote: 'Tailnet', t3Url: fakes.lab.url, mintPairingCode: fakes.lab.mintCommand(), access: 'auto', maxConcurrentJobs: 1 },
    ],
    projects: [
      { alias: 'atlas-web', description: 'Customer web app', host: 'studio', t3ProjectId: 'project-1', runtimeMode: 'full-access' },
      { alias: 'field-notes', description: 'Docs site and release notes', host: 'studio', t3ProjectId: 'project-2', runtimeMode: 'auto' },
      { alias: 'harbor', description: 'Coordinator-run monorepo', host: 'studio', t3ProjectId: 'project-3', runtimeMode: 'full-access', allowWorkStart: false },
      { alias: 'ledger-api', description: 'Billing service', host: 'forge', t3ProjectId: 'project-1', runtimeMode: 'approval-required' },
      { alias: 'tide-ml', description: 'Training pipelines', host: 'forge', t3ProjectId: 'project-2', runtimeMode: 'full-access' },
      { alias: 'sandbox', description: 'Scratch repository', host: 'lab', t3ProjectId: 'project-1', runtimeMode: 'auto' },
    ],
    // The configured port is a placeholder when the OS picks one (dashboardPort 0).
    dashboard: { enabled: true, listen: { host: '127.0.0.1', port: options.dashboardPort || 3791 }, basePath: options.basePath ?? '/', clientLabels: {} },
  });
  const logger = options.logger ?? silentLogger;
  // Client labels are set once the clients exist (ids are random); the config object is the gateway's own.
  // A busy file (Windows keeps SQLite files locked until closed) is retried; the directory is removed on every exit path.
  const dataDir = mkdtempSync(join(tmpdir(), 't3fg-dashboard-demo-'));
  const removeDataDir = () => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const gateway = await startGateway({
    reachability: { autoStart: false },
    config, dataDir, logger, clock, dashboardDemoLabel: options.badge === undefined ? 'Synthetic demo' : options.badge ?? undefined,
    port: 0, dashboardPort: options.dashboardPort ?? 0, jobEngine: { autoStart: false },
    webhookManagement: { loopbackOnly: true, ...(options.webhookReceiver ? { allowLoopbackHttp: true, attemptTimeoutMs: 1000 } : {}) },
  }).catch(async (error: unknown) => {
    removeDataDir();
    await door.close().catch(() => {});
    for (const fake of Object.values(fakes)) await fake.close().catch(() => {});
    throw error;
  });
  door.forwardTo(gateway.port);
  const { services, engine } = gateway;
  const agents: Agent[] = [];
  let webhookReceiver: DemoWebhookReceiver | null = null;
  const close = async () => {
    try {
      for (const agent of agents) await agent.close().catch(() => {});
      await gateway.close();
      await webhookReceiver?.close();
      await door.close();
      for (const fake of Object.values(fakes)) await fake.close();
    } finally {
      removeDataDir();
    }
  };
  try {
    for (const id of ['studio', 'forge', 'lab']) await services.registry.enroll(id);
    if (scenario === 'mixed') {
      fakes.lab.rejectDecisions = true;
      await services.registry.renewDue();
    }
    const mint = () => services.approvals.mint().code;
    const tick = async (ms = 2 * MINUTE) => {
      advance(ms);
      await engine.tick();
    };

    if (scenario !== 'empty') {
      // Clients: an OAuth connector that operates everywhere, a read-only OAuth client for one host, a bearer-token agent.
      const grokLogin = await signIn(mcpUrl, mint, 'Grok connector', CALLBACKS.grok, 'operate', 'all');
      config.dashboard.clientLabels[grokLogin.clientId] = 'Grok Bot';
      const grok = await connect(mcpUrl, grokLogin.clientId, grokLogin.accessToken, grokLogin.refreshToken);
      agents.push(grok);
      advance(4 * MINUTE);
      const museLogin = await signIn(mcpUrl, mint, 'Muse', CALLBACKS.muse, 'read', ['studio']);
      const muse = await connect(mcpUrl, museLogin.clientId, museLogin.accessToken, museLogin.refreshToken);
      agents.push(muse);
      const notionToken = services.tokens.issueOperatorToken({
        name: 'Notion', scopes: scopesForGrant('operate', 'all'),
        expiresAt: clock() + (scenario === 'auth-issue' ? 9 * DAY : 330 * DAY),
      });
      // A registration nobody approved: shown in its own list, never as a client.
      await fetch(`${mcpUrl}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Untitled MCP client', redirect_uris: ['https://unknown.example.net/cb'] }),
      });

      await grok.call('fleet_status');
      advance(3 * MINUTE);
      const start = async (project: string, title: string, task: string) => {
        const result = await grok.call('work_start', { project, title, task, requestId: `demo-${randomToken(6)}` });
        return (result.job as { jobId: string }).jobId;
      };
      const thread = (fake: FakeT3, jobId: string) => fake.threadForJob(jobId).threadId;

      // A coordinator thread the operator adopted on the studio, which delegates work.
      const { threadId: coordinatorThread } = fakes.studio.launchDirect({ projectId: 'project-3', title: 'Chief of staff', message: 'Coordinate the harbor monorepo' });
      await services.jobs.adopt({ project: 'harbor', threadId: coordinatorThread, title: 'Chief of staff' });
      await tick(6 * MINUTE);

      const darkMode = await start('atlas-web', 'Add dark mode to settings', 'Synthetic task: add a dark mode toggle to the settings page.');
      const flaky = await start('atlas-web', 'Fix flaky checkout test', 'Synthetic task: stabilise the checkout end-to-end test.');
      await tick(3 * MINUTE);
      const migrations = await start('ledger-api', 'Audit pending migrations', 'Synthetic task: review the pending database migrations.');
      await tick(5 * MINUTE);
      fakes.studio.finishTurn(thread(fakes.studio, flaky), 'Synthetic reply: the test is stable now.');
      await tick(25 * MINUTE);

      const notes = await start('field-notes', 'Draft 2.4 release notes', 'Synthetic task: draft the release notes for 2.4.');
      await tick(4 * MINUTE);
      const tls = await start('tide-ml', 'Pin dataset loader version', 'Synthetic task: pin the dataset loader and rerun the smoke suite.');
      await tick(9 * MINUTE);
      fakes.studio.delegate(coordinatorThread, 'Synthetic delegated task');
      fakes.studio.delegate(coordinatorThread, 'Synthetic delegated task 2');
      fakes.studio.endTurn(coordinatorThread);
      await tick(40 * MINUTE);

      // In the mixed fleet Notion holds a valid token but has never made a request (connecting is a request).
      if (scenario !== 'mixed') {
        const notion = await connect(mcpUrl, notionToken.clientId, notionToken.token);
        agents.push(notion);
        await notion.call('fleet_status');
        await notion.call('work_list', { limit: 5 });
      }
      await tick(50 * MINUTE);

      if (scenario === 'mixed') {
        fakes.forge.requestApproval(thread(fakes.forge, migrations));
        await tick(12 * MINUTE);
        fakes.forge.askQuestion(thread(fakes.forge, tls), [{
          id: 'q1', header: 'Synthetic', question: 'Synthetic question?', options: [{ label: 'Yes', description: 'Synthetic' }, { label: 'No', description: 'Synthetic' }],
        }]);
        await tick(20 * MINUTE);
        fakes.studio.failRun(thread(fakes.studio, notes));
        await tick(15 * MINUTE);
      } else {
        fakes.forge.finishTurn(thread(fakes.forge, migrations), 'Synthetic reply: migrations reviewed.');
        fakes.forge.finishTurn(thread(fakes.forge, tls), 'Synthetic reply: pinned.');
        fakes.studio.finishTurn(thread(fakes.studio, notes), 'Synthetic reply: drafted.');
        await tick(30 * MINUTE);
      }

      // A queued job behind a full host, and one cancelled before it launched.
      await start('tide-ml', 'Re-run nightly evaluation', 'Synthetic task: re-run the nightly evaluation.');
      const cancelled = await start('ledger-api', 'Rename invoice fields', 'Synthetic task: rename the invoice fields.');
      await grok.call('work_cancel', { jobId: cancelled });
      await tick(20 * MINUTE);
      await muse.call('fleet_status');
      await muse.call('work_list', { limit: 10 });
      await tick(30 * MINUTE);
      fakes.studio.finishTurn(thread(fakes.studio, darkMode), 'Synthetic reply: dark mode added.');
      await tick(25 * MINUTE);
      // The operator types into the idle thread in T3; the job runs a turn it did not get from an agent.
      fakes.studio.userTurn(thread(fakes.studio, darkMode), 'Synthetic follow-up typed in T3');
      await tick(20 * MINUTE);
      await grok.call('work_continue', { jobId: flaky, message: 'Synthetic follow-up: also cover the retry path.', requestId: `demo-${randomToken(6)}` });
      await tick(15 * MINUTE);

      // Grok refreshes as connectors do before their access token expires.
      const rotated = await (await refresh(mcpUrl, grokLogin.clientId, grokLogin.refreshToken)).json() as { access_token: string; refresh_token: string };
      advance(10 * MINUTE);
      if (scenario === 'auth-issue') {
        // Muse refreshes, then an old copy of its first refresh token is presented again after the grace window: the family is revoked.
        await refresh(mcpUrl, museLogin.clientId, museLogin.refreshToken);
        advance(15 * MINUTE);
        await refresh(mcpUrl, museLogin.clientId, museLogin.refreshToken);
      }
      const grokAgain = await connect(mcpUrl, grokLogin.clientId, rotated.access_token, rotated.refresh_token);
      agents.push(grokAgain);
      offset = -40 * MINUTE;
      fakes.studio.finishTurn(thread(fakes.studio, flaky), 'Synthetic reply: retry path covered.');
      await engine.tick();
      offset = -18 * MINUTE;
      await engine.tick();
      offset = -3 * MINUTE;
      await grokAgain.call('work_feed', { cursor: 0, limit: 20 });
      await grokAgain.call('fleet_status');
    }

    offset = -2 * MINUTE;
    await engine.tick();
    if (scenario === 'mixed' || scenario === 'host-down') {
      await fakes.forge.stop();
      offset = -MINUTE;
      await engine.tick();
    }
    offset = 0;
    if (scenario !== 'empty') await gateway.dashboard!.checks.run();
    if (options.runEngine) engine.start();
    if (options.webhookReceiver) webhookReceiver = await startDemoWebhookReceiver();
  } catch (error) {
    await close();
    throw error;
  }
  const dashboard = gateway.dashboard!;
  return { gateway, fakes, mcpUrl, dashboardUrl: `http://127.0.0.1:${dashboard.port}${dashboard.path}`, webhookReceiver, close };
}

export function demoLogger(): Logger {
  return createLogger({ level: 'warn', sink: (line) => process.stderr.write(`${line}\n`) });
}
