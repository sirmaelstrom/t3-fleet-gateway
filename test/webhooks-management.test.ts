import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, request, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { DashboardChecks } from '../src/dashboard/checks.ts';
import { startDashboard } from '../src/dashboard/server.ts';
import { WebhookManagement, parseDashboardRoute } from '../src/webhooks/management.ts';
import type { WebhookConnection } from '../src/webhooks/store.ts';
import { startTestGateway, type TestGateway } from './helpers/gateway.ts';

const HEADER = 'Authorization: Bearer synthetic-private:key';
const API = { 'x-t3fg-dashboard': '1' };
const CONFIG = {
  projects: [{ alias: 'pilot', host: 'main', t3ProjectId: 'project-1' }],
  dashboard: { enabled: true, basePath: '/fleet', allowedHosts: ['dashboard.example.test', 'other.example.test'] },
};
interface Receipt { path: string; payload: Record<string, unknown>; auth: string | undefined; response: ServerResponse }
async function receiver(t: TestContext) {
  const receipts: Receipt[] = [];
  const waits: { predicate: (r: Receipt) => boolean; resolve: (r: Receipt) => void }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const receipt = { path: req.url!, payload: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      auth: req.headers.authorization, response: res };
    receipts.push(receipt);
    for (const wait of waits.splice(0)) {
      if (wait.predicate(receipt)) wait.resolve(receipt); else waits.push(wait);
    }
    if (receipt.path.startsWith('/hold')) return;
    if (receipt.path === '/redirect') res.writeHead(307, { location: '/unexpected' }).end();
    else res.writeHead(receipt.path === '/reject' ? 401 : 202).end('synthetic-private-response');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const next = (predicate: (r: Receipt) => boolean): Promise<Receipt> => {
    const found = receipts.find(predicate);
    return found ? Promise.resolve(found) : new Promise((resolve) => waits.push({ predicate, resolve }));
  };
  return { origin, receipts, next };
}
function raw(port: number, path: string, method = 'GET', headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function fixture(t: TestContext, autoStart = false, timeout = 2000) {
  const target = await receiver(t);
  const gw = await startTestGateway(t, { config: CONFIG, jobEngine: { autoStart: false },
    webhookSender: { autoStart }, webhookManagement: { allowLoopbackHttp: true, attemptTimeoutMs: timeout } });
  const api = access(gw);
  const list = await api.list();
  return { target, gw, api, session: list.session };
}
function access(gw: TestGateway) {
  const port = gw.gateway.dashboard!.port;
  const headers = { ...API, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` };
  return {
    port, headers,
    async list() {
      const result = await raw(port, '/fleet/api/webhooks', 'GET', API);
      assert.equal(result.status, 200, result.text);
      return JSON.parse(result.text) as { session: string; projects: { alias: string; host: string }[]; connections: (WebhookConnection & { displayName: string })[] };
    },
    async post(action: string, body: Record<string, unknown>) {
      const result = await raw(port, `/fleet/api/webhooks/${action}`, 'POST', headers, JSON.stringify(body));
      return { ...result, body: JSON.parse(result.text) as { error?: string; code?: string; test?: { outcome: string; statusCode: number } } };
    },
  };
}
async function connect(f: Awaited<ReturnType<typeof fixture>>, path = '/accept') {
  const input = { session: f.session, requestId: randomUUID(), project: 'pilot', url: f.target.origin + path, authHeader: HEADER };
  const result = await f.api.post('connect', input);
  assert.equal(result.status, 200, result.text);
  const connection = (await f.api.list()).connections[0]!;
  return { input, connection };
}
function enqueue(gw: TestGateway, id: string) {
  const jobs = gw.services.jobs.store;
  jobs.create({ id, clientId: 'synthetic-client', requestId: id, inputHash: id, projectAlias: 'pilot', hostId: 'main',
    task: 'Synthetic task body', title: 'Synthetic job', branch: `fleet/${id}`, runtimeMode: 'auto' });
  jobs.transition(id, { from: ['queued'], to: 'cancelled' });
}
const actionInput = (session: string, row: WebhookConnection) => ({ session, requestId: randomUUID(), id: row.id, revision: row.revision });

describe('private webhook connection management', () => {
  test('setup persists defaults and never exports or logs route/header/response; empty-config sender wakes', async (t) => {
    const f = await fixture(t, true);
    assert.deepEqual((await f.api.list()).projects, [{ alias: 'pilot', host: 'main', projectId: 'project-1', label: 'pilot' }]);
    const { connection } = await connect(f);
    assert.equal(connection.source, 'dashboard');
    assert.equal(connection.lastTest!.statusCode, 202);
    assert.equal(f.target.receipts[0]!.auth, 'Bearer synthetic-private:key');
    assert.deepEqual(Object.keys(f.target.receipts[0]!.payload).sort(), ['eventId', 'feedCursor', 'feedSequence', 'timestamp', 'type']);
    const settings = JSON.parse(String(f.gw.services.db.prepare('SELECT settings FROM webhook_subscriptions').get()!.settings));
    assert.deepEqual([...settings.events].sort(), ['cancelled', 'credential_alert', 'credential_resolved', 'delegated_work_ended', 'failed', 'idle', 'needs_input']);
    assert.equal(settings.excerptChars, 0);
    enqueue(f.gw, 'uiwake0001');
    const event = await f.target.next((r) => r.payload.type === 'cancelled');
    assert.equal(event.payload.jobId, 'uiwake0001');
    assert.equal('excerpt' in event.payload, false);
    const snapshot = await raw(f.api.port, '/fleet/api/snapshot', 'GET', API);
    const visible = JSON.stringify(await f.api.list()) + snapshot.text + JSON.stringify(f.gw.services.webhooks.diagnostics()) + f.gw.logs.join('');
    for (const privateValue of ['synthetic-private:key', f.target.origin, 'synthetic-private-response', HEADER]) {
      assert.equal(visible.includes(privateValue), false, 'private webhook material must never be reflected');
    }
  });

  for (const [path, outcome] of [['/reject', 'http_error'], ['/redirect', 'redirect'], ['/hold-timeout', 'timeout']]) {
    test(`setup ${outcome} never activates a destination`, async (t) => {
      const f = await fixture(t, false, 80);
      const result = await f.api.post('connect', { session: f.session, requestId: randomUUID(), project: 'pilot',
        url: f.target.origin + path, authHeader: HEADER });
      assert.equal(result.status, 502);
      assert.equal(result.body.test!.outcome, outcome);
      assert.deepEqual((await f.api.list()).connections, []);
      assert.equal(f.target.receipts.length, 1);
    });
  }

  test('failed replacement preserves the old route, successful replacement changes URL/key and cancels old payloads', async (t) => {
    const f = await fixture(t);
    const { connection } = await connect(f);
    enqueue(f.gw, 'replace001');
    const failed = await f.api.post('replace', { ...actionInput(f.session, connection), url: f.target.origin + '/reject', authHeader: 'X-Test: new-key' });
    assert.equal(failed.status, 502);
    assert.equal((await f.api.list()).connections[0]!.revision, connection.revision);
    const tested = await f.api.post('test', actionInput(f.session, connection));
    assert.equal(tested.status, 200);
    assert.equal(f.target.receipts.at(-1)!.path, '/accept');
    assert.equal(f.target.receipts.at(-1)!.auth, 'Bearer synthetic-private:key');
    const replaced = await f.api.post('replace', { ...actionInput(f.session, connection), url: f.target.origin + '/replacement', authHeader: 'Authorization: changed-key' });
    assert.equal(replaced.status, 200);
    assert.notEqual((await f.api.list()).connections[0]!.revision, connection.revision);
    const old = f.gw.services.db.prepare('SELECT state, payload FROM webhook_deliveries').get()!;
    assert.equal(old.state, 'cancelled'); assert.equal(old.payload, null);
    enqueue(f.gw, 'replace002');
    await f.gw.gateway.webhooks.tick();
    assert.equal(f.target.receipts.at(-1)!.path, '/replacement');
    assert.equal(f.target.receipts.at(-1)!.auth, 'changed-key');
  });

  test('disconnect during awaited replacement or test cancels queue and cannot resurrect or update the removed connection', async (t) => {
    const f = await fixture(t);
    const { input, connection } = await connect(f);
    enqueue(f.gw, 'disconnect1');
    const pending = f.api.post('replace', { ...actionInput(f.session, connection), url: f.target.origin + '/hold-replace', authHeader: HEADER });
    const held = await f.target.next((r) => r.path === '/hold-replace');
    const disconnected = await f.api.post('disconnect', actionInput(f.session, connection));
    assert.equal(disconnected.status, 200);
    held.response.writeHead(202).end();
    assert.equal((await pending).status, 404);
    assert.deepEqual((await f.api.list()).connections, []);
    assert.equal(f.gw.services.db.prepare('SELECT state FROM webhook_deliveries').get()!.state, 'cancelled');
    const replay = await f.api.post('connect', input);
    assert.equal(replay.status, 200, 'a replay returns the original receipt without recreating the connection');
    assert.deepEqual((await f.api.list()).connections, []);

    const next = await connect(f);
    const changed = await f.api.post('replace', { ...actionInput(f.session, next.connection), url: f.target.origin + '/accept2', authHeader: HEADER });
    assert.equal(changed.status, 200);
    const current = (await f.api.list()).connections[0]!;
    // A real test request can stay on the wire while disconnect commits.
    const saved = f.gw.services.webhooks.route(current.id, current.revision);
    const testRoute = { ...saved, url: f.target.origin + '/hold-test' };
    const stored = f.gw.services.webhooks.replaceDashboard(current.id, current.revision, testRoute,
      { eventId: randomUUID(), at: f.gw.clock(), result: { outcome: 'delivered', statusCode: 202 } });
    const testing = f.api.post('test', actionInput(f.session, stored));
    const heldTest = await f.target.next((r) => r.path === '/hold-test');
    await f.api.post('disconnect', actionInput(f.session, stored));
    heldTest.response.writeHead(202).end();
    assert.equal((await testing).status, 404);
    assert.deepEqual((await f.api.list()).connections, []);
  });

  test('a slower replacement cannot overwrite a newer replacement and identical in-flight submissions share one POST', async (t) => {
    const f = await fixture(t);
    const { connection } = await connect(f);
    const input = { ...actionInput(f.session, connection), url: f.target.origin + '/hold-slow', authHeader: HEADER };
    const slow = f.api.post('replace', input);
    const held = await f.target.next((r) => r.path === '/hold-slow');
    const repeated = f.api.post('replace', input);
    const newer = await f.api.post('replace', { ...actionInput(f.session, connection), url: f.target.origin + '/newer', authHeader: HEADER });
    assert.equal(newer.status, 200);
    held.response.writeHead(202).end();
    const firstResult = await slow;
    const repeatedResult = await repeated;
    assert.equal(firstResult.status, 409);
    assert.equal(repeatedResult.status, firstResult.status);
    assert.deepEqual(repeatedResult.body, firstResult.body);
    assert.equal(f.target.receipts.filter((r) => r.path === '/hold-slow').length, 1);
    const current = (await f.api.list()).connections[0]!;
    await f.api.post('test', actionInput(f.session, current));
    assert.equal(f.target.receipts.at(-1)!.path, '/newer');
  });

  test('bounded operation cache rejects altered retries and rotates sessions without reaccepting old creation requests', async (t) => {
    const f = await fixture(t);
    const { connection, input } = await connect(f);
    assert.equal((await f.api.post('connect', { ...input, url: f.target.origin + '/changed' })).body.error, 'request_conflict');
    const disconnected = actionInput(f.session, connection);
    await f.api.post('disconnect', disconnected);
    for (let n = 0; n < 126; n++) {
      assert.equal((await f.api.post('test', actionInput(f.session, connection))).status, 404);
    }
    assert.equal((await f.api.post('test', actionInput(f.session, connection))).status, 429);
    const next = await f.api.list();
    assert.notEqual(next.session, f.session);
    assert.equal((await f.api.post('connect', input)).body.error, 'session_expired');
    assert.deepEqual((await f.api.list()).connections, []);
  });

  test('four stalled operations are bounded while disconnect remains available', async (t) => {
    const f = await fixture(t);
    const { connection } = await connect(f);
    const held = [];
    const operations = [];
    for (let i = 0; i < 4; i++) {
      operations.push(f.api.post('replace', { ...actionInput(f.session, connection), url: f.target.origin + `/hold-${i}`, authHeader: HEADER }));
      held.push(await f.target.next((r) => r.path === `/hold-${i}`));
    }
    assert.equal((await f.api.post('test', actionInput(f.session, connection))).body.error, 'busy');
    assert.equal((await f.api.post('disconnect', actionInput(f.session, connection))).status, 200);
    for (const receipt of held) receipt.response.writeHead(202).end();
    assert.deepEqual((await Promise.all(operations)).map((r) => r.status), [404, 404, 404, 404]);
  });

  test('startup gate rejects writes and shutdown aborts/drains a real stalled setup ping before closing SQLite', async (t) => {
    const f = await fixture(t, false, 10_000);
    const management = new WebhookManagement(f.gw.services.webhooks, f.gw.services.config, f.gw.clock, f.gw.services.logger, () => {});
    assert.equal((await management.execute('connect', {})).status, 503);
    management.ready();
    await management.stop();
    management.ready();
    assert.equal((await management.execute('connect', {})).status, 503);
    const setup = f.api.post('connect', { session: f.session, requestId: randomUUID(), project: 'pilot',
      url: f.target.origin + '/hold-shutdown', authHeader: HEADER });
    await f.target.next((r) => r.path === '/hold-shutdown');
    const closing = f.gw.gateway.close();
    const result = await setup;
    assert.equal(result.status, 503);
    await closing;
    assert.throws(() => f.gw.services.db.prepare('SELECT 1'), /closed|not open/i);
    const restarted = await startTestGateway(t, { dataDir: f.gw.dataDir, door: f.gw.door, config: CONFIG, jobEngine: { autoStart: false } });
    assert.deepEqual((await access(restarted).list()).connections, [], 'aborted setup did not commit');
    assert.equal(f.gw.logs.some((line) => line.includes('management_failed')), false);
  });

  test('a reserved dashboard listener refuses HTTP mutations before readiness and after stop', async (t) => {
    const f = await fixture(t);
    const { config, db, clock, registry, logger, jobs } = f.gw.services;
    const manager = new WebhookManagement(f.gw.services.webhooks, config, clock, logger, () => {}, { allowLoopbackHttp: true });
    const checks = new DashboardChecks({ config, db, clock, registry, logger, dataDir: f.gw.dataDir });
    const dashboard = await startDashboard({ dashboard: config.dashboard, logger, checks, management: manager, port: 0,
      sources: { config, db, clock, registry, store: jobs.store, engine: f.gw.gateway.engine, startedAt: clock(),
        mcpListen: `127.0.0.1:${f.gw.gateway.port}`, lastChecks: () => null } });
    t.after(() => dashboard.close());
    const headers = { ...API, origin: `http://127.0.0.1:${dashboard.port}`, 'content-type': 'application/json' };
    const session = manager.list().session;
    const body = JSON.stringify({ session, requestId: randomUUID(), project: 'pilot', url: f.target.origin + '/accept', authHeader: HEADER });
    const submit = () => raw(dashboard.port, '/fleet/api/webhooks/connect', 'POST', headers, body);
    assert.equal((await submit()).status, 503);
    assert.equal(f.target.receipts.length, 0);
    manager.ready();
    assert.equal((await submit()).status, 200);
    await manager.stop();
    assert.equal((await submit()).status, 503);
    assert.equal(f.target.receipts.length, 1);
  });

  test('restart resumes persisted UI queues with empty config; config-owned routes reconcile independently', async (t) => {
    const f = await fixture(t);
    const { connection } = await connect(f);
    enqueue(f.gw, 'restart001');
    writeFileSync(join(f.gw.dataDir, 'file.key'), 'synthetic-file-key', { mode: 0o600 });
    await f.gw.gateway.close();
    const configured = { subscriptions: [{ id: 'file-managed', enabled: true, url: f.target.origin + '/file',
      auth: { header: 'X-File-Key', secretFile: 'file.key' }, allowLoopbackHttp: true }] };
    const restarted = await startTestGateway(t, { dataDir: f.gw.dataDir, door: f.gw.door, config: { ...CONFIG, webhooks: configured },
      jobEngine: { autoStart: false }, webhookSender: { autoStart: false } });
    const api = access(restarted);
    const list = await api.list();
    assert.equal(list.connections.length, 2);
    assert.equal(list.connections.find((row) => row.id === connection.id)!.revision, connection.revision);
    const file = list.connections.find((row) => row.source === 'config')!;
    for (const action of ['replace', 'disconnect']) {
      const response = await api.post(action, { ...actionInput(list.session, file), ...(action === 'replace' ? { authHeader: HEADER } : {}) });
      assert.equal(response.body.error, 'file_managed');
    }
    assert.equal((await api.post('test', actionInput(list.session, file))).status, 200);
    await restarted.gateway.close();
    const again = await startTestGateway(t, { dataDir: f.gw.dataDir, door: f.gw.door, config: CONFIG, jobEngine: { autoStart: false } });
    assert.deepEqual((await access(again).list()).connections.map((row) => row.id), [connection.id]);
    const delivery = await f.target.next((r) => r.payload.jobId === 'restart001');
    assert.equal(delivery.path, '/accept');
    assert.equal(again.services.webhooks.listConnections()[0]!.revision, connection.revision);
  });

  test('management API enforces exact Origin, Host, Funnel, content bounds, and listener separation', async (t) => {
    const f = await fixture(t);
    const body = JSON.stringify({ session: f.session, requestId: randomUUID(), project: 'pilot', url: f.target.origin + '/accept', authHeader: HEADER });
    const send = (headers: Record<string, string>, text = body) => raw(f.api.port, '/fleet/api/webhooks/connect', 'POST', headers, text);
    const missingOrigin = { ...f.api.headers }; delete (missingOrigin as Partial<typeof missingOrigin>).origin;
    const missingApi = { ...f.api.headers }; delete (missingApi as Record<string, string>)['x-t3fg-dashboard'];
    for (const [headers, status] of [
      [missingOrigin, 403], [missingApi, 403],
      [{ ...f.api.headers, origin: 'null' }, 403],
      [{ ...f.api.headers, host: 'dashboard.example.test', origin: 'https://other.example.test' }, 403],
      [{ ...f.api.headers, host: 'dashboard.example.test', origin: 'http://dashboard.example.test' }, 403],
      [{ ...f.api.headers, 'sec-fetch-site': 'same-site' }, 403],
      [{ ...f.api.headers, 'sec-fetch-site': 'cross-site' }, 403],
      [{ ...f.api.headers, 'tailscale-funnel-request': '1' }, 403],
      [{ ...f.api.headers, host: 'foreign.example.test' }, 421],
      [{ ...f.api.headers, 'content-type': 'text/plain' }, 415],
    ] as [Record<string, string>, number][]) {
      const result = await send(headers); assert.equal(result.status, status, result.text);
      assert.equal('access-control-allow-origin' in result.headers, false);
    }
    assert.equal((await send(f.api.headers, 'x'.repeat(16 * 1024 + 1))).status, 413);
    assert.equal((await send(f.api.headers, '{"url":"synthetic-secret"')).status, 400);
    const mcp = await raw(f.gw.gateway.port, '/fleet/api/webhooks/connect', 'POST', f.api.headers, body);
    assert.equal(mcp.status, 404);
    assert.equal((await raw(f.api.port, '/mcp')).status, 404);
    assert.equal((await raw(f.api.port, '/oauth/token', 'POST')).status, 404);
    assert.equal(f.target.receipts.length, 0);
    const valid = await send({ ...f.api.headers, host: 'dashboard.example.test', origin: 'https://dashboard.example.test', 'sec-fetch-site': 'same-origin' });
    assert.equal(valid.status, 200, valid.text);
    assert.equal(valid.headers['cache-control'], 'no-store');
    assert.equal(f.target.receipts.length, 1);
  });

  test('route parser trims and splits first colon, rejects control headers/values and malformed fields without reflection', async (t) => {
    assert.deepEqual(parseDashboardRoute(' https://receiver.example.test/private ', ' Authorization : Bearer synthetic:key '),
      { url: 'https://receiver.example.test/private', header: 'authorization', value: 'Bearer synthetic:key' });
    const f = await fixture(t);
    for (const authHeader of ['missing-colon-secret', 'Authorization:', 'Host: unsafe', 'Content-Type: unsafe',
      'X-Forwarded-For: unsafe', 'Sec-Test: unsafe', 'Authorization: bad\r\nInjected: secret', 'Authorization: bad\tsecret', 'Bad header: secret']) {
      const result = await f.api.post('connect', { session: f.session, requestId: randomUUID(), project: 'pilot', url: f.target.origin, authHeader });
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'invalid_route');
      assert.equal(result.text.includes(authHeader), false);
    }
    for (const url of ['http://receiver.example.test/private', 'https://user:pass@receiver.example.test', 'https://receiver.example.test/#key',
      'https://receiver.example.test/\nkey', 'not-a-url-secret']) assert.equal(parseDashboardRoute(url, HEADER), null);
    const invalid = await f.api.post('connect', { session: f.session, requestId: randomUUID(), project: 'pilot', url: f.target.origin,
      authHeader: HEADER, arbitrary: 'secret' });
    assert.deepEqual(invalid.body, { error: 'invalid_request' });
    assert.equal(f.target.receipts.length, 0);
  });
});

test('all enrolled discovery hosts are listed; a remote alias and direct target deliver only to their host/project connections', async (t) => {
  const { startFakeT3 } = await import('./helpers/fakeT3.ts');
  const { connectAgent } = await import('./helpers/jobs.ts');
  const hostA = await startFakeT3(); t.after(() => hostA.close());
  const hostB = await startFakeT3(); t.after(() => hostB.close());
  const sink = await receiver(t);
  const gw = await startTestGateway(t, {
    config: { ...CONFIG,
      hosts: [
        { id: 'host-a', t3Url: hostA.url, mintPairingCode: hostA.mintCommand(), discovery: { enabled: true, allowWorkStart: true } },
        { id: 'host-b', t3Url: hostB.url, mintPairingCode: hostB.mintCommand(), discovery: { enabled: true, allowWorkStart: true } },
        { id: 'host-c', t3Url: 'http://127.0.0.1:9', discovery: { enabled: true } },
      ],
      projects: [{ alias: 'remote', host: 'host-b', t3ProjectId: 'project-1' }],
    }, jobEngine: { autoStart: false }, webhookSender: { autoStart: false }, webhookManagement: { allowLoopbackHttp: true },
  });
  await gw.services.registry.enroll('host-a');
  await gw.services.registry.enroll('host-b');
  const api = access(gw);
  const list = await api.list();
  const discovered = list.projects as { alias: string; host: string; projectId?: string }[];
  assert.ok(discovered.some((p) => p.alias === 'remote'));
  for (const host of ['host-a', 'host-b']) {
    for (const projectId of ['project-1', 'project-2']) {
      const choice = discovered.find((p) => p.host === host && p.projectId === projectId)!;
      assert.ok(choice);
      const connected = await api.post('connect', { session: list.session, requestId: randomUUID(), project: choice.alias,
        url: `${sink.origin}/${host}/${projectId}`, authHeader: HEADER });
      assert.equal(connected.status, 200, connected.text);
    }
  }
  const rawList = JSON.parse((await raw(api.port, '/fleet/api/webhooks', 'GET', API)).text);
  assert.deepEqual(rawList.hosts.find((h: { host: string }) => h.host === 'host-c'), { host: 'host-c', status: 'unavailable' });
  const agent = await connectAgent(t, gw);
  const alias = await agent.call<{ job: { jobId: string } }>('work_start', { project: 'remote', task: 'Synthetic alias task', requestId: 'alias-start' });
  const direct = await agent.call<{ job: { jobId: string } }>('work_start', { target: { host: 'host-b', projectId: 'project-2' },
    task: 'Synthetic discovered task', requestId: 'direct-start' });
  await gw.gateway.engine.tick();
  for (const job of [alias.job, direct.job]) hostB.finishTurn(hostB.threadForJob(job.jobId).threadId, 'Synthetic result');
  await gw.gateway.engine.tick();
  await gw.gateway.webhooks.tick();
  const events = sink.receipts.filter((r) => r.payload.type !== 'ping');
  assert.deepEqual(events.map((r) => r.path).sort(), ['/host-b/project-1', '/host-b/project-2']);
  assert.deepEqual(events.map((r) => r.payload.jobId).sort(), [alias.job.jobId, direct.job.jobId].sort());
  assert.ok(events.every((r) => r.payload.host === 'host-b' && r.payload.type === 'idle'));
  await hostA.stop();
  gw.clock.advance(31_000);
  const degraded = JSON.parse((await raw(api.port, '/fleet/api/webhooks', 'GET', API)).text);
  assert.equal(degraded.hosts.find((h: { host: string }) => h.host === 'host-a').status, 'unavailable');
  assert.ok(degraded.projects.some((p: { host: string; projectId?: string }) => p.host === 'host-b' && p.projectId === 'project-2'));
  assert.ok(degraded.projects.some((p: { alias: string }) => p.alias === 'remote'));
});

test('dashboard connections accept precise filters and expose persistent delivery health without route material', async (t) => {
  const f = await fixture(t);
  const input = { session: f.session, requestId: randomUUID(), project: 'pilot', url: f.target.origin + '/accept', authHeader: HEADER,
    jobs: ['filtered01'], clients: ['synthetic-client'], events: ['cancelled'] };
  const response = await f.api.post('connect', input);
  assert.equal(response.status, 200, response.text);
  const saved = (await f.api.list()).connections[0]!;
  assert.deepEqual(saved.jobs, input.jobs); assert.deepEqual(saved.clients, input.clients); assert.deepEqual(saved.events, input.events);
  enqueue(f.gw, 'filtered01'); enqueue(f.gw, 'filtered02');
  const claim = f.gw.services.webhooks.claim(1, 30_000)[0]!;
  assert.equal(JSON.parse(claim.payload).jobId, 'filtered01');
  f.gw.services.webhooks.finish(claim, { outcome: 'http_error', statusCode: 503 });
  const result = await raw(f.api.port, '/fleet/api/webhooks', 'GET', API);
  const health = JSON.parse(result.text).connections[0].health;
  assert.equal(health.failureStreak, 1);
  assert.equal(health.pending, 1);
  assert.equal(health.lastSuccessAt, null);
  for (const secret of [f.target.origin, HEADER, 'synthetic-private:key']) assert.equal(result.text.includes(secret), false);
  const invalid = await f.api.post('connect', { ...input, requestId: randomUUID(), events: ['unrecognized'] });
  assert.equal(invalid.status, 400);
  assert.equal(f.target.receipts.length, 1, 'invalid filters fail before sending a test');
});

test('event-filter replacement tests before commit and preserves precise filters when enabling credential alerts', async (t) => {
  const f = await fixture(t);
  const setup = await f.api.post('connect', { session: f.session, requestId: randomUUID(), project: 'pilot',
    url: f.target.origin + '/accept', authHeader: HEADER, events: ['idle'], jobs: ['synthetic-job'], clients: ['synthetic-client'] });
  assert.equal(setup.status, 200);
  const before = (await f.api.list()).connections[0]!;
  const events = ['idle', 'credential_alert', 'credential_resolved'];
  const failed = await f.api.post('replace', { ...actionInput(f.session, before), url: f.target.origin + '/reject', authHeader: HEADER, events });
  assert.equal(failed.status, 502);
  assert.deepEqual((await f.api.list()).connections[0]!.events, ['idle']);
  const result = await f.api.post('replace', { ...actionInput(f.session, before), authHeader: HEADER, events });
  assert.equal(result.status, 200);
  const after = (await f.api.list()).connections[0]!;
  assert.deepEqual(after.events, events);
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.clients, before.clients);
  assert.deepEqual(after.targets, before.targets);
  assert.notEqual(after.revision, before.revision);
});


test('connection display names resolve on the gateway at read time by host and project ID', async (t) => {
  const { startFakeT3 } = await import('./helpers/fakeT3.ts');
  const host = await startFakeT3(); t.after(() => host.close());
  const gw = await startTestGateway(t, {
    config: { ...CONFIG, hosts: [{ id: 'main', t3Url: host.url, mintPairingCode: host.mintCommand(), discovery: { enabled: true } }] },
    jobEngine: { autoStart: false }, webhookSender: { autoStart: false },
  });
  await gw.services.registry.enroll('main');
  const route = { url: 'https://receiver.example.test/hook', header: 'authorization', value: 'synthetic-key' };
  const ping = { eventId: randomUUID(), at: gw.clock(), result: { outcome: 'delivered' as const, statusCode: 202 } };
  const store = gw.services.webhooks;
  store.connectDashboard('paired', '', 'main', route, ping, 'project-1');
  store.connectDashboard('named', '', 'main', route, ping, 'project-2');
  store.connectDashboard('unknown', '', 'main', route, ping, 'missing-project');
  store.connectDashboard('other-host', '', 'other', route, ping, 'project-1');
  store.connectDashboard('legacy', 'pilot', 'main', route, ping);
  const api = access(gw);
  const names = async () => Object.fromEntries((await api.list()).connections.map((row) => [row.id, row.displayName]));
  const first = await names();
  assert.equal(first.paired, 'pilot');
  assert.equal(first.named, 'Synthetic project 2');
  assert.equal(first.unknown, 'missing-project');
  assert.equal(first['other-host'], 'project-1', 'same ID on another host must not borrow an alias or name');
  assert.equal(first.legacy, 'pilot');
  const before = store.listConnections();
  gw.services.config.projects[0]!.alias = 'renamed';
  assert.equal((await names()).paired, 'renamed', 'read current config, not a name saved at connection creation');
  gw.services.config.projects = [];
  assert.equal((await names()).paired, 'Synthetic project 1');
  assert.deepEqual(store.listConnections(), before, 'display names never rewrite connection settings or revisions');
  await gw.gateway.close();
  const restarted = await startTestGateway(t, {
    dataDir: gw.dataDir, door: gw.door,
    config: { ...CONFIG, projects: [{ ...CONFIG.projects[0], alias: 'after-restart' }] },
    jobEngine: { autoStart: false }, webhookSender: { autoStart: false },
  });
  const refreshed = (await access(restarted).list()).connections;
  assert.equal(refreshed.find((row) => row.id === 'paired')!.displayName, 'after-restart');
  assert.equal(refreshed.find((row) => row.id === 'named')!.displayName, 'project-2', 'unavailable discovery falls back to ID');
  assert.deepEqual(restarted.services.webhooks.listConnections(), before);
});


test('project options deduplicate aliases and compute readable labels with same-host collision suffixes', async (t) => {
  const { startFakeT3 } = await import('./helpers/fakeT3.ts');
  const host = await startFakeT3(); t.after(() => host.close());
  host.projects.splice(0, host.projects.length,
    { ...host.projects[0]!, id: 'aliased-id', title: 'Discovered alias name' },
    { ...host.projects[0]!, id: 'unique-id', title: 'Readable name' },
    { ...host.projects[0]!, id: 'collision-a', title: 'Shared' },
    { ...host.projects[0]!, id: 'collision-b', title: 'Shared' },
    { ...host.projects[0]!, id: 'alias-collision', title: 'configured' },
    { ...host.projects[0]!, id: 'title-only-id', title: 'title-alias' },
  );
  const gw = await startTestGateway(t, {
    config: { ...CONFIG,
      hosts: ['main', 'other'].map((id) => ({ id, t3Url: host.url, mintPairingCode: host.mintCommand(), discovery: { enabled: true } })),
      projects: [
        { alias: 'configured', host: 'main', t3ProjectId: 'aliased-id' },
        { alias: 'second-binding', host: 'main', t3ProjectId: 'aliased-id' },
        { alias: 'title-alias', host: 'main', t3ProjectTitle: 'Title-selected project' },
      ],
    }, jobEngine: { autoStart: false }, webhookSender: { autoStart: false },
  });
  await gw.services.registry.enroll('main');
  await gw.services.registry.enroll('other');
  const list = await access(gw).list();
  const options = list.projects as { alias: string; host: string; projectId?: string; label: string }[];
  const main = options.filter((p) => p.host === 'main');
  assert.equal(main.length, 7, 'each pinned project appears once, plus the title-based alias with no known ID');
  assert.equal(main.some((p) => p.alias === 'second-binding'), false, 'first configured binding represents a shared project');
  assert.equal(main.find((p) => p.alias === 'title-alias')!.label, 'title-alias');
  assert.equal(main.find((p) => p.projectId === 'title-only-id')!.label, 'title-alias (title-on)');
  assert.equal(main.find((p) => p.projectId === 'aliased-id')!.alias, 'configured', 'keep alias selection semantics');
  assert.equal(main.find((p) => p.projectId === 'aliased-id')!.label, 'configured (aliased-)');
  assert.equal(main.find((p) => p.projectId === 'alias-collision')!.label, 'configured (alias-co)');
  assert.equal(main.find((p) => p.projectId === 'unique-id')!.label, 'Readable name');
  assert.equal(main.find((p) => p.projectId === 'collision-a')!.label, 'Shared (collision-a)');
  assert.equal(main.find((p) => p.projectId === 'collision-b')!.label, 'Shared (collision-b)');
  const other = options.filter((p) => p.host === 'other');
  assert.equal(other.length, 6, 'alias on another host never hides a discovered project');
  assert.equal(other.find((p) => p.projectId === 'aliased-id')!.label, 'Discovered alias name');
  assert.equal(other.find((p) => p.projectId === 'alias-collision')!.label, 'configured', 'collisions on another host do not add a suffix');
  assert.equal(other.find((p) => p.projectId === 'unique-id')!.label, 'Readable name', 'same label across hosts needs no suffix');
});
