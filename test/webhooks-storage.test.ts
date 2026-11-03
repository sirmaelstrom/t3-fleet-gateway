import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { openDataDir } from '../src/dataDir.ts';
import { migrate, openDatabase, SCHEMA_VERSION, schemaVersion } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { JobStore } from '../src/jobs/store.ts';
import { silentLogger } from '../src/log.ts';
import { webhooksSchema } from '../src/webhooks/config.ts';
import { MAX_ATTEMPTS_PER_SUBSCRIPTION, MAX_PAYLOAD_BYTES, MAX_PENDING_PER_SUBSCRIPTION, MAX_SUBSCRIPTIONS,
  WebhookStore, type DashboardTest } from '../src/webhooks/store.ts';
import { testClock } from './helpers/clock.ts';
import { rowsWithoutV12 } from './helpers/migrations.ts';
import { tempDir } from './helpers/tmp.ts';

function fixture(t: TestContext) {
  const dir = join(tempDir(t), 'data');
  const data = openDataDir(dir);
  const db = openDatabase(data.databasePath);
  t.after(() => db.close());
  const clock = testClock();
  writeFileSync(join(dir, 'synthetic.key'), 'synthetic-private-header', { mode: 0o600 });
  const webhooks = new WebhookStore(db, clock);
  const config = webhooksSchema.parse({ subscriptions: [{ id: 'synthetic', enabled: true, url: 'https://routine.example.com/private',
    auth: { header: 'X-Synthetic-Key', secretFile: 'synthetic.key' } }] });
  webhooks.reconcile(config, dir);
  const jobs = new JobStore(db, clock, silentLogger);
  return { dir, db, clock, webhooks, config, jobs };
}

function createJob(jobs: JobStore, id = 'synthetic01') {
  return jobs.create({ id, clientId: 'synthetic-client', requestId: id, inputHash: id,
    projectAlias: 'pilot', hostId: 'main', task: 'Synthetic private task', title: 'Synthetic safe title', branch: `fleet/${id}`, runtimeMode: 'auto' }).job;
}

const dashboardRoute = { url: 'https://receiver.example.com/synthetic-private-route?key=synthetic-path-secret',
  header: 'authorization', value: 'Bearer synthetic-dashboard-key' };
function successfulTest(at: number, eventId = 'synthetic-test'): DashboardTest {
  return { eventId, at, result: { outcome: 'delivered', statusCode: 204 } };
}

describe('webhook migration and durable store boundaries', () => {
  test('migration 9 preserves a populated version 8 database and never invents historical events or attribution', (t) => {
    const path = openDataDir(join(tempDir(t), 'data')).databasePath;
    const old = new DatabaseSync(path);
    migrate(old, MIGRATIONS.slice(0, 8));
    assert.equal(schemaVersion(old), 8);
    old.exec(`
      INSERT INTO oauth_clients (id, name, redirect_uris, created_at, last_used_at, last_mcp_success_at)
        VALUES ('client-1', 'Synthetic agent', '[]', 1, 42, 50);
      INSERT INTO token_families (id, client_id, scope, resource, created_at)
        VALUES ('family-1', 'client-1', 'fleet:operate', 'https://gateway.example.com/mcp', 1);
      INSERT INTO refresh_tokens (token_hash, family_id, scope, created_at, expires_at)
        VALUES ('synthetic-refresh-hash', 'family-1', 'fleet:operate', 1, 9000);
      INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
        VALUES ('synthetic-access-hash', 'family-1', 'synthetic-refresh-hash', 'fleet:operate', 1, 1000);
      INSERT INTO host_credentials (host_id, t3_client_id, access_token, scope, access, issued_at, expires_at, verified_at)
        VALUES ('main', 'synthetic-t3-client', 'synthetic-t3-token', 'orchestration', 'full-access', 1, 9000, 1);
      INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
        created_at, updated_at, state_changed_at, last_run_id, latest_message_excerpt, latest_message_truncated, launch_spec)
        VALUES ('oldjob0001', 'client-1', 'request-1', 'pilot', 'main', 'project-1', 'idle', 'Synthetic private task',
          'Synthetic old job', 'fleet/oldjob0001', 'auto', 1, 2, 2, 'old-run', 'Synthetic old excerpt', 1, '{"v":1}');
      INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
        t3_thread_id, created_at, updated_at, state_changed_at, standing, activity_position, read_position)
        VALUES ('standing01', 'operator', 'adopted', 'pilot', 'main', 'project-1', 'idle', '', 'Synthetic coordinator', '', '',
          'thread-1', 1, 2, 3, 1, 20, 12);
      INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('oldjob0001', 'created', 'queued', 1);
      INSERT INTO job_events (job_id, type, from_state, to_state, detail, created_at)
        VALUES ('oldjob0001', 'state_changed', 'running', 'idle', '{"reason":"completed"}', 2);
      INSERT INTO job_events (job_id, type, to_state, detail, created_at)
        VALUES ('standing01', 'created', 'idle', '{"reason":"adopted"}', 1);
      INSERT INTO idempotency_keys (client_id, tool, request_id, input_hash, job_id, created_at)
        VALUES ('client-1', 'work_start', 'request-1', 'synthetic-request-hash', 'oldjob0001', 1);
    `);
    const tables = ['oauth_clients', 'token_families', 'refresh_tokens', 'access_tokens', 'host_credentials', 'jobs', 'job_events', 'idempotency_keys'];
    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    old.close();
    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.deepEqual(tables.map((table) => rowsWithoutV12(db, table)), before);
    for (const table of ['job_turns', 'webhook_subscriptions', 'webhook_deliveries', 'webhook_attempts']) {
      assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), [], `${table} begins empty`);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE job_events SET type = 'changed'").run(), /append-only/);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    assert.deepEqual(schema(db), schema(fresh));
  });

  test('separate connections claim exclusively, recover abandoned attempts, and reject stale completions', (t) => {
    const f = fixture(t);
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled' } });
    const original = f.webhooks.claim(1, 1000)[0]!;
    assert.ok(original);
    const otherDb = openDatabase(join(f.dir, 'gateway.db'));
    t.after(() => otherDb.close());
    const other = new WebhookStore(otherDb, f.clock);
    assert.deepEqual(other.claim(1, 1000), [], 'a second writer cannot claim an active lease');
    f.clock.advance(1000);
    const resumed = other.claim(1, 1000)[0]!;
    assert.equal(resumed.eventId, original.eventId);
    assert.equal(resumed.payload, original.payload);
    assert.notEqual(resumed.lease, original.lease);
    f.webhooks.finish(original, { outcome: 'delivered', statusCode: 200 });
    assert.equal(other.active(resumed), true, 'late completion from an abandoned owner cannot finish the new attempt');
    other.finish(resumed, { outcome: 'delivered', statusCode: 204 });
    assert.deepEqual(other.claim(1, 1000), []);
    assert.deepEqual(other.diagnostics().attempts.map((row) => row.outcome), ['delivered', 'abandoned']);
    assert.equal(f.db.prepare('SELECT payload FROM webhook_deliveries').get()!.payload, null, 'settled history retains no payload');
  });

  test('separate connections allow only one in-flight delivery per subscription and release its successor on completion', (t) => {
    const f = fixture(t);
    const jobs = ['synthetic01', 'synthetic02', 'synthetic03'].map((id) => createJob(f.jobs, id));
    for (const job of jobs) f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled' });
    const otherDb = openDatabase(join(f.dir, 'gateway.db'));
    t.after(() => otherDb.close());
    const other = new WebhookStore(otherDb, f.clock);
    const first = f.webhooks.claim(4, 1000);
    assert.equal(first.length, 1, 'one batch cannot occupy several slots with one subscription');
    assert.equal(JSON.parse(first[0]!.payload).jobId, jobs[0]!.id);
    assert.deepEqual(other.claim(4, 1000), [], 'another connection cannot claim either pending successor while the first is sending');

    f.webhooks.finish(first[0]!, { outcome: 'delivered', statusCode: 204 });
    const second = other.claim(4, 1000);
    assert.equal(second.length, 1, 'completion makes the next event immediately claimable without advancing time');
    assert.equal(JSON.parse(second[0]!.payload).jobId, jobs[1]!.id);
    assert.deepEqual(f.webhooks.claim(4, 1000), [], 'the second owner excludes the first connection from the remaining successor');

    other.finish(second[0]!, { outcome: 'delivered', statusCode: 204 });
    const third = f.webhooks.claim(4, 1000);
    assert.equal(third.length, 1);
    assert.equal(JSON.parse(third[0]!.payload).jobId, jobs[2]!.id);
    assert.equal(new Set([...first, ...second, ...third].map((claim) => claim.eventId)).size, 3);
    f.webhooks.finish(third[0]!, { outcome: 'delivered', statusCode: 204 });
    assert.deepEqual(other.claim(4, 1000), []);
  });

  test('auth rotation invalidates pending old deliveries and missing replacement credentials fail atomically', (t) => {
    const f = fixture(t);
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled' } });
    const revision = f.db.prepare('SELECT revision FROM webhook_subscriptions').get()!.revision;
    writeFileSync(join(f.dir, 'synthetic.key'), '', { mode: 0o600 });
    assert.throws(() => f.webhooks.reconcile(f.config, f.dir), { code: 'config_invalid' });
    assert.equal(f.db.prepare('SELECT revision FROM webhook_subscriptions').get()!.revision, revision);
    assert.equal(f.db.prepare('SELECT state FROM webhook_deliveries').get()!.state, 'pending');
    writeFileSync(join(f.dir, 'synthetic.key'), 'synthetic-rotated-key', { mode: 0o600 });
    f.webhooks.reconcile(f.config, f.dir);
    assert.notEqual(f.db.prepare('SELECT revision FROM webhook_subscriptions').get()!.revision, revision);
    assert.deepEqual(f.webhooks.claim(1, 1000), []);
    assert.deepEqual({ ...f.db.prepare('SELECT state, payload FROM webhook_deliveries').get() }, { state: 'cancelled', payload: null });
  });

  test('dashboard connections keep fixed event defaults, project and host filters, no excerpts and safe metadata only', (t) => {
    const f = fixture(t);
    const prior = createJob(f.jobs, 'priorjob01');
    f.jobs.transition(prior.id, { from: ['queued'], to: 'cancelled' });
    const connection = f.webhooks.connectDashboard('dashboard-one', 'pilot', 'main', dashboardRoute, successfulTest(f.clock()));
    assert.deepEqual(connection, {
      id: 'dashboard-one', revision: connection.revision, source: 'dashboard', projects: ['pilot'], hosts: ['main'], targets: [],
      jobs: [], clients: [], ownerClientId: null, events: ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended', 'credential_alert', 'credential_resolved'],
      lastTest: { at: new Date(f.clock()).toISOString(), outcome: 'delivered', statusCode: 204 },
    });
    const settings = JSON.parse(f.db.prepare("SELECT settings FROM webhook_subscriptions WHERE id = 'dashboard-one'").get()!.settings as string);
    assert.deepEqual(settings, { projects: ['pilot'], hosts: ['main'],
      events: ['needs_input', 'idle', 'failed', 'cancelled', 'delegated_work_ended', 'credential_alert', 'credential_resolved'], excerptChars: 0 });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE subscription_id = 'dashboard-one'").get()!.n, 0,
      'connecting does not replay history');
    for (const [id, projectAlias, hostId] of [['matchjob01', 'pilot', 'main'], ['otherjob01', 'other', 'main'], ['otherjob02', 'pilot', 'other']]) {
      const job = f.jobs.create({ id: id!, clientId: 'synthetic-client', requestId: id!, inputHash: id!, projectAlias: projectAlias!, hostId: hostId!,
        task: 'Synthetic private task', title: 'Synthetic safe title', branch: `fleet/${id}`, runtimeMode: 'auto' }).job;
      f.jobs.update(job.id, { latestMessageExcerpt: 'Synthetic worker secret' });
      f.jobs.transition(job.id, { from: ['queued'], to: 'running' });
      f.jobs.transition(job.id, { from: ['running'], to: 'idle' });
    }
    const rows = f.db.prepare("SELECT payload FROM webhook_deliveries WHERE subscription_id = 'dashboard-one'").all();
    assert.equal(rows.length, 1, 'both project and host must match, and running is excluded');
    assert.equal(JSON.parse(rows[0]!.payload as string).jobId, 'matchjob01');
    assert.equal('excerpt' in JSON.parse(rows[0]!.payload as string), false);
    assert.equal(f.webhooks.listConnections().find((row) => row.id === 'synthetic')!.source, 'config');
    const safe = JSON.stringify([f.webhooks.listConnections(), f.webhooks.diagnostics()]);
    for (const secret of [dashboardRoute.url, dashboardRoute.header, dashboardRoute.value, 'Synthetic private task', 'Synthetic worker secret']) {
      assert.equal(safe.includes(secret), false, `safe metadata excludes ${secret}`);
    }
    const file = f.webhooks.listConnections().find((row) => row.id === 'synthetic')!;
    assert.throws(() => f.webhooks.dashboardRoute(file.id, file.revision), { code: 'file_managed' });
    assert.throws(() => f.webhooks.replaceDashboard(file.id, file.revision, dashboardRoute, successfulTest(f.clock())), { code: 'file_managed' });
    assert.throws(() => f.webhooks.disconnectDashboard(file.id, file.revision), { code: 'file_managed' });
    assert.throws(() => f.webhooks.connectDashboard(file.id, 'pilot', 'main', dashboardRoute, successfulTest(f.clock())), { code: 'file_managed' });
  });

  test('reopening preserves dashboard routes and queues while config removal, disable and re-enable act independently', (t) => {
    const f = fixture(t);
    const connection = f.webhooks.connectDashboard('dashboard-one', 'pilot', 'main', dashboardRoute, successfulTest(f.clock()));
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled' });
    const before = f.db.prepare("SELECT * FROM webhook_subscriptions WHERE id = 'dashboard-one'").get();
    const queued = f.db.prepare("SELECT * FROM webhook_deliveries WHERE subscription_id = 'dashboard-one'").all();
    const restartedDb = openDatabase(join(f.dir, 'gateway.db'));
    t.after(() => restartedDb.close());
    const restarted = new WebhookStore(restartedDb, f.clock);
    const disabled = { subscriptions: [{ ...f.config.subscriptions[0]!, enabled: false }] };
    restarted.reconcile(disabled, f.dir);
    assert.deepEqual(restarted.listConnections(), [connection]);
    assert.deepEqual(restartedDb.prepare("SELECT * FROM webhook_subscriptions WHERE id = 'dashboard-one'").get(), before);
    assert.deepEqual(restartedDb.prepare("SELECT * FROM webhook_deliveries WHERE subscription_id = 'dashboard-one'").all(), queued);
    assert.equal(restartedDb.prepare("SELECT state FROM webhook_deliveries WHERE subscription_id = 'synthetic'").get()!.state, 'cancelled');
    restarted.reconcile({ subscriptions: [] }, f.dir);
    assert.deepEqual(restarted.listConnections(), [connection]);
    restarted.reconcile(disabled, f.dir);
    assert.deepEqual(restarted.listConnections(), [connection], 'disabled config must never auto-enable on restart');
    restarted.reconcile(f.config, f.dir);
    assert.equal(restarted.listConnections().length, 2);
    assert.deepEqual(restarted.listConnections()[0], connection);
    const claim = restarted.claim(4, 1000);
    assert.equal(claim.length, 1);
    assert.equal(claim[0]!.subscriptionId, connection.id);
    assert.deepEqual(claim[0]!.route, dashboardRoute);
    assert.equal(claim[0]!.payload, queued[0]!.payload, 'the original immutable payload survives restart');
  });

  test('config ownership collisions, including disabled entries, fail atomically without changing either owner', (t) => {
    const f = fixture(t);
    f.webhooks.connectDashboard('dashboard-one', 'pilot', 'main', dashboardRoute, successfulTest(f.clock()));
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled' });
    const snapshot = () => ['webhook_subscriptions', 'webhook_deliveries', 'webhook_attempts']
      .map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    for (const enabled of [true, false]) {
      const config = { subscriptions: [{ ...f.config.subscriptions[0]!, id: 'dashboard-one', enabled }] };
      assert.throws(() => f.webhooks.reconcile(config, f.dir), { code: 'config_invalid' });
      assert.deepEqual(snapshot(), before);
    }
  });

  test('the shared 32-subscription limit covers both owners and failed reconciliation preserves all rows', (t) => {
    const f = fixture(t);
    for (let index = 0; index < MAX_SUBSCRIPTIONS - 1; index++) {
      f.webhooks.connectDashboard(`dashboard-${index}`, 'pilot', 'main', dashboardRoute, successfulTest(f.clock(), `ping-${index}`));
    }
    assert.equal(f.webhooks.listConnections().length, MAX_SUBSCRIPTIONS);
    assert.throws(() => f.webhooks.connectDashboard('one-too-many', 'pilot', 'main', dashboardRoute, successfulTest(f.clock())),
      { code: 'connection_limit' });
    const before = f.webhooks.listConnections();
    const config = { subscriptions: [...f.config.subscriptions, { ...f.config.subscriptions[0]!, id: 'new-file-route' }] };
    assert.throws(() => f.webhooks.reconcile(config, f.dir), { code: 'config_invalid' });
    assert.deepEqual(f.webhooks.listConnections(), before);
    f.webhooks.reconcile({ subscriptions: [] }, f.dir);
    f.webhooks.connectDashboard('last-dashboard', 'pilot', 'main', dashboardRoute, successfulTest(f.clock()));
    assert.equal(f.webhooks.listConnections().length, MAX_SUBSCRIPTIONS);
    assert.throws(() => f.webhooks.reconcile(f.config, f.dir), { code: 'config_invalid' });
    assert.equal(f.webhooks.listConnections().length, MAX_SUBSCRIPTIONS);
  });

  test('failed setup and replacement leave the working route and leases untouched; successful replacement cancels its old queue only', (t) => {
    const f = fixture(t);
    const failed: DashboardTest = { eventId: 'failed-test', at: f.clock(), result: { outcome: 'http_error', statusCode: 401 } };
    assert.throws(() => f.webhooks.connectDashboard('failed-connect', 'pilot', 'main', dashboardRoute, failed), { code: 'test_failed' });
    assert.equal(f.webhooks.listConnections().length, 1);
    const connection = f.webhooks.connectDashboard('dashboard-one', 'pilot', 'main', dashboardRoute, successfulTest(f.clock()));
    for (const id of ['synthetic01', 'synthetic02']) f.jobs.transition(createJob(f.jobs, id).id, { from: ['queued'], to: 'cancelled' });
    const claims = f.webhooks.claim(4, 1000);
    const oldClaim = claims.find((claim) => claim.subscriptionId === connection.id)!;
    const configClaim = claims.find((claim) => claim.subscriptionId === 'synthetic')!;
    const oldQueue = f.db.prepare('SELECT * FROM webhook_deliveries WHERE subscription_id = ?').all(connection.id);
    const replacement = { ...dashboardRoute, url: 'https://replacement.example.com/new-synthetic-private-path', value: 'Bearer new-synthetic-key' };
    assert.throws(() => f.webhooks.replaceDashboard(connection.id, connection.revision, replacement, failed), { code: 'test_failed' });
    assert.deepEqual(f.webhooks.dashboardRoute(connection.id, connection.revision), dashboardRoute);
    assert.deepEqual(f.db.prepare('SELECT * FROM webhook_deliveries WHERE subscription_id = ?').all(connection.id), oldQueue);
    assert.equal(f.webhooks.active(oldClaim), true);
    const next = f.webhooks.replaceDashboard(connection.id, connection.revision, replacement, successfulTest(f.clock()));
    assert.notEqual(next.revision, connection.revision);
    assert.deepEqual(f.webhooks.dashboardRoute(next.id, next.revision), replacement);
    assert.equal(f.webhooks.active(oldClaim), false);
    assert.equal(f.webhooks.active(configClaim), true, 'a different subscription is unaffected');
    const cancelled = f.db.prepare('SELECT state, payload, lease, lease_until FROM webhook_deliveries WHERE subscription_id = ?').all(connection.id);
    assert.deepEqual(cancelled.map((row) => ({ ...row })), Array.from({ length: 2 }, () =>
      ({ state: 'cancelled', payload: null, lease: null, lease_until: null })));
    assert.equal(f.db.prepare('SELECT outcome FROM webhook_attempts WHERE delivery_id = ?').get(oldClaim.id)!.outcome, 'cancelled');
    f.webhooks.finish(oldClaim, { outcome: 'delivered', statusCode: 204 });
    assert.equal(f.db.prepare('SELECT state FROM webhook_deliveries WHERE id = ?').get(oldClaim.id)!.state, 'cancelled');
  });

  test('stale completions from another store cannot overwrite a newer replacement or resurrect a disconnect', (t) => {
    const f = fixture(t);
    const original = f.webhooks.connectDashboard('dashboard-one', 'pilot', 'main', dashboardRoute, successfulTest(f.clock()));
    assert.throws(() => f.webhooks.connectDashboard(original.id, 'pilot', 'main', dashboardRoute, successfulTest(f.clock())),
      { code: 'connection_conflict' }, 'repeated create cannot reset an existing connection');
    const otherDb = openDatabase(join(f.dir, 'gateway.db'));
    t.after(() => otherDb.close());
    const other = new WebhookStore(otherDb, f.clock);
    other.dashboardRoute(original.id, original.revision); // The management caller captures this revision before its awaited ping.
    const newer = f.webhooks.replaceDashboard(original.id, original.revision, { ...dashboardRoute, value: 'Bearer newer-synthetic-key' },
      successfulTest(f.clock(), 'newer-ping'));
    assert.throws(() => other.replaceDashboard(original.id, original.revision, dashboardRoute, successfulTest(f.clock(), 'slow-ping')),
      { code: 'connection_conflict' });
    assert.throws(() => other.testConnection(original.id, original.revision, successfulTest(f.clock())), { code: 'connection_conflict' });
    assert.throws(() => other.disconnectDashboard(original.id, original.revision), { code: 'connection_conflict' });
    assert.equal(f.webhooks.dashboardRoute(newer.id, newer.revision).value, 'Bearer newer-synthetic-key');
    for (const id of ['synthetic01', 'synthetic02']) f.jobs.transition(createJob(f.jobs, id).id, { from: ['queued'], to: 'cancelled' });
    const oldClaim = f.webhooks.claim(4, 1000).find((claim) => claim.subscriptionId === newer.id)!;
    other.dashboardRoute(newer.id, newer.revision);
    f.webhooks.disconnectDashboard(newer.id, newer.revision);
    assert.throws(() => other.replaceDashboard(newer.id, newer.revision, dashboardRoute, successfulTest(f.clock())), { code: 'not_found' });
    assert.throws(() => other.testConnection(newer.id, newer.revision, successfulTest(f.clock())), { code: 'not_found' });
    assert.throws(() => other.disconnectDashboard(newer.id, newer.revision), { code: 'not_found' });
    f.webhooks.finish(oldClaim, { outcome: 'delivered', statusCode: 204 });
    assert.equal(f.webhooks.active(oldClaim), false);
    assert.equal(other.listConnections().some((row) => row.id === newer.id), false);
    assert.deepEqual(f.db.prepare('SELECT state, payload FROM webhook_deliveries WHERE subscription_id = ?').all(newer.id).map((row) => ({ ...row })),
      [{ state: 'cancelled', payload: null }, { state: 'cancelled', payload: null }]);
  });

  test('saved-route tests work for either source and older completions cannot replace newer safe test diagnostics', (t) => {
    const f = fixture(t);
    f.webhooks.connectDashboard('dashboard-one', 'pilot', 'main', dashboardRoute, successfulTest(f.clock()));
    for (const connection of f.webhooks.listConnections()) {
      assert.equal(typeof f.webhooks.route(connection.id, connection.revision).value, 'string');
      const newer = { eventId: `new-${connection.id}`, at: f.clock() + 10, result: { outcome: 'http_error' as const, statusCode: 401 } };
      const result = f.webhooks.testConnection(connection.id, connection.revision, newer);
      assert.equal(result.revision, connection.revision, 'testing does not replace the route');
      assert.deepEqual(result.lastTest, { at: new Date(newer.at).toISOString(), outcome: 'http_error', statusCode: 401 });
      const older = f.webhooks.testConnection(connection.id, connection.revision, successfulTest(f.clock(), `old-${connection.id}`));
      assert.deepEqual(older.lastTest, result.lastTest);
      assert.equal(f.webhooks.diagnostics(connection.id).attempts[0]!.outcome, 'delivered', 'both attempts remain in bounded history');
    }
  });

  test('queued and steered sends never establish a run initiator or replace its existing caller', (t) => {
    const f = fixture(t);
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'running', changes: { lastRunId: 'known-run' },
      gatewayTurn: { runId: 'known-run', clientId: 'original-caller' } });
    f.jobs.recordSend(job.id, { runId: 'known-run', delivery: 'queued' }, 'other-caller', 'queued-1');
    f.jobs.recordSend(job.id, { runId: 'known-run', delivery: 'steered' }, 'other-caller', 'steered-1');
    assert.deepEqual(f.db.prepare('SELECT * FROM job_turns').all().map((row) => ({ ...row })),
      [{ job_id: job.id, run_id: 'known-run', client_id: 'original-caller' }]);
    f.jobs.recordSend(job.id, { runId: 'unseen-run', delivery: 'queued' }, 'other-caller', 'queued-2');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM job_turns').get()!.n, 1);
    f.jobs.transition(job.id, { from: ['running'], to: 'idle', changes: { lastRunId: 'unseen-run' } });
    assert.deepEqual(JSON.parse(f.webhooks.claim(1, 1000)[0]!.payload).turnInitiator, { kind: 'unknown', clientId: null });
  });

  test('oversized upstream metadata is reported as payload overflow without truncating identifiers or blocking the job/feed', (t) => {
    const f = fixture(t);
    const job = f.jobs.create({ id: 'oversize01', clientId: 'synthetic-client', requestId: 'oversize', inputHash: 'oversize',
      projectAlias: 'pilot', hostId: 'main', task: 'Synthetic task', title: `Synthetic upstream title ${'x'.repeat(MAX_PAYLOAD_BYTES)}`,
      branch: 'fleet/oversize01', runtimeMode: 'auto' }).job;
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled' });
    assert.equal(f.jobs.require(job.id).state, 'cancelled');
    assert.equal(f.jobs.recentEvents(job.id, 10).at(-1)!.toState, 'cancelled');
    assert.deepEqual(f.webhooks.claim(1, 1000), []);
    const diagnostics = f.webhooks.diagnostics();
    assert.equal(diagnostics.subscriptions[0]!.overflow_count, 1);
    assert.equal(diagnostics.subscriptions[0]!.overflow_reason, 'payload_limit');
    assert.equal(diagnostics.subscriptions[0]!.overflow_sequence, f.jobs.recentEvents(job.id, 10).at(-1)!.id);
    assert.equal(JSON.stringify(diagnostics).includes('Synthetic upstream title'), false);
  });

  test('bounded attempts and terminal history preserve active backlog; overflow is explicit with a feed recovery sequence', (t) => {
    const f = fixture(t);
    const job = createJob(f.jobs);
    f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled' } });
    const row = f.db.prepare('SELECT * FROM webhook_deliveries').get()!;
    f.db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
      INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
      SELECT ?, ?, 'synthetic-backlog-' || n, ?, ?, ?, ?, ?, 'pending' FROM sequence`)
      .run(MAX_PENDING_PER_SUBSCRIPTION - 1, row.subscription_id!, row.revision!, row.feed_sequence!, row.payload!, row.created_at!, row.expires_at!, row.next_attempt_at!);
    const overflow = createJob(f.jobs, 'synthetic02');
    f.jobs.transition(overflow.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled' } });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'pending'").get()!.n, MAX_PENDING_PER_SUBSCRIPTION);
    const diagnostics = f.webhooks.diagnostics();
    assert.equal(diagnostics.subscriptions[0]!.overflow_count, 1);
    assert.equal(diagnostics.subscriptions[0]!.overflow_sequence, f.db.prepare('SELECT MAX(id) AS n FROM job_events').get()!.n);
    assert.equal(f.jobs.require(overflow.id).state, 'cancelled', 'bounded delivery backlog never blocks a job transition');

    f.db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < 1004)
      INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
      SELECT ?, ?, 'synthetic-terminal-' || n, ?, NULL, ?, ?, ?, 'delivered' FROM sequence`)
      .run(row.subscription_id!, row.revision!, row.feed_sequence!, row.created_at!, row.expires_at!, row.next_attempt_at!);

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SUBSCRIPTION + 4; attempt++) {
      f.webhooks.recordPing('synthetic', `synthetic-ping-${attempt}`, f.clock(), { outcome: 'http_error', statusCode: 503 });
    }
    assert.equal(f.webhooks.diagnostics('synthetic', 9999).attempts.length, MAX_ATTEMPTS_PER_SUBSCRIPTION);
    assert.equal(f.webhooks.diagnostics('synthetic', 2).attempts.length, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'delivered'").get()!.n, 1000);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state = 'pending'").get()!.n, MAX_PENDING_PER_SUBSCRIPTION);
    assert.equal(JSON.stringify(f.webhooks.diagnostics()).includes('synthetic-private-header'), false);
    assert.equal(JSON.stringify(f.webhooks.diagnostics()).includes('Synthetic private task'), false);
  });
});

test('migration 15 preserves populated v14 subscriptions, secrets, revisions, queues and diagnostics byte-for-byte', (t) => {
  const path = join(tempDir(t), 'previous.db');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 14));
  const clock = testClock();
  const webhooks = new WebhookStore(db, clock);
  const jobs = new JobStore(db, clock, silentLogger);
  // Historical fixtures use the historical layout, not current code which requires newer tables.
  const connection = { id: 'existing-route', revision: 'synthetic-revision' };
  db.prepare(`INSERT INTO webhook_subscriptions (id, revision, identity, settings, route, source)
    VALUES (?, ?, 'synthetic-identity', ?, ?, 'dashboard')`).run(connection.id, connection.revision,
      JSON.stringify({ projects: ['pilot'], hosts: ['main'], events: ['cancelled'], excerptChars: 0 }), JSON.stringify(dashboardRoute));
  // Disabled config entries have no active persisted row. Preserve a legacy settings object too.
  db.prepare(`INSERT INTO webhook_subscriptions (id, revision, identity, settings, route, source)
    VALUES ('legacy-file', 'synthetic-revision', 'synthetic-identity', ?, ?, 'config')`)
    .run(JSON.stringify({ enabled: false, hosts: ['main'], projects: ['pilot'], events: ['cancelled'], excerptChars: 0 }), JSON.stringify(dashboardRoute));
  const job = createJob(jobs);
  // Seed the historical layout directly: the current transition also cleans the attachment table added later.
  db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(job.id);
  const event = db.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES (?, 'state_changed', 'cancelled', ?)")
    .run(job.id, clock());
  db.prepare(`INSERT INTO webhook_deliveries (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
    VALUES (?, ?, 'historical-event', ?, '{}', ?, ?, ?, 'pending')`)
    .run(connection.id, connection.revision, Number(event.lastInsertRowid), clock(), clock() + 60_000, clock());
  const tables = ['webhook_subscriptions', 'webhook_deliveries', 'webhook_attempts', 'job_events', 'jobs'];
  const before = tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  migrate(db);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
  assert.deepEqual(webhooks.route(connection.id, connection.revision), dashboardRoute);
  assert.throws(() => migrate(db, MIGRATIONS.slice(0, 14)), /schema version \d+ is newer/);
  assert.equal(webhooks.claim(1, 30_000).length, 1, 'pending delivery still dispatches');
});

test('paired config targets never turn into a cross product of host and project filters', (t) => {
  const f = fixture(t);
  f.webhooks.reconcile(webhooksSchema.parse({ subscriptions: [{ ...f.config.subscriptions[0],
    targets: [{ host: 'host-a', projectId: 'project-1' }, { host: 'host-b', projectId: 'project-2' }],
  }] }), f.dir);
  for (const host of ['host-a', 'host-b']) {
    for (const projectId of ['project-1', 'project-2']) {
      const id = `${host}-${projectId}`;
      const job = f.jobs.create({ id, clientId: 'synthetic-client', requestId: id, inputHash: id,
        projectAlias: 'synthetic-alias', hostId: host, t3ProjectId: projectId, task: 'Synthetic task', title: 'Synthetic title',
        branch: '', runtimeMode: 'auto' }).job;
      f.jobs.transition(job.id, { from: ['queued'], to: 'cancelled' });
    }
  }
  const claims = f.webhooks.claim(4, 30_000);
  // One in-flight request per subscription; settle it before claiming the next.
  assert.equal(claims.length, 1);
  f.webhooks.finish(claims[0]!, { outcome: 'delivered', statusCode: 200 });
  const next = f.webhooks.claim(4, 30_000);
  assert.equal(next.length, 1);
  assert.deepEqual([...claims, ...next].map((c) => JSON.parse(c.payload).jobId).sort(), ['host-a-project-1', 'host-b-project-2']);
});
