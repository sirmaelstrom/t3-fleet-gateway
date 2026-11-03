import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { checkDataDirPermissions, openDataDir } from '../src/dataDir.ts';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase, SCHEMA_VERSION, schemaVersion } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { LaunchSpec } from '../src/jobs/launchSpec.ts';
import { JobStore } from '../src/jobs/store.ts';
import { silentLogger } from '../src/log.ts';
import { rowsWithoutV12 } from './helpers/migrations.ts';
import { tempDir } from './helpers/tmp.ts';

describe('data directory', () => {
  test('creates a private directory and key file', (t) => {
    const dir = join(tempDir(t), 'data');
    const data = openDataDir(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'gateway.key')).mode & 0o777, 0o600);
    assert.equal(data.key.length, 32);
    assert.deepEqual(openDataDir(dir).key, data.key, 'the key is stable across opens');
  });

  test('refuses a directory readable by others', (t) => {
    const dir = tempDir(t);
    chmodSync(dir, 0o755);
    assert.throws(() => openDataDir(dir), { code: 'data_dir_insecure' });
  });

  test('refuses a key or database file readable by others', (t) => {
    const dir = join(tempDir(t), 'data');
    const data = openDataDir(dir);
    openDatabase(data.databasePath).close();
    checkDataDirPermissions(dir);
    chmodSync(data.databasePath, 0o644);
    assert.throws(() => checkDataDirPermissions(dir), /chmod 600/);
    chmodSync(data.databasePath, 0o600);
    chmodSync(join(dir, 'gateway.key'), 0o640);
    assert.throws(() => openDataDir(dir), { code: 'data_dir_insecure' });
  });
});

describe('database', () => {
  test('opens in WAL mode with a busy timeout and private files', (t) => {
    const data = openDataDir(join(tempDir(t), 'data'));
    const db = openDatabase(data.databasePath);
    t.after(() => db.close());
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(statSync(data.databasePath + suffix).mode & 0o077, 0, `gateway.db${suffix} is private`);
    }
  });

  test('creates every table the gateway and the job layer need', (t) => {
    const db = openDatabase(join(tempDir(t), 'test.db'));
    t.after(() => db.close());
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'));
    assert.deepEqual(tables, [
      'access_tokens',
      'approval_codes',
      'approval_failures',
      'authorization_codes',
      'client_project_access',
      'client_thread_scopes',
      'credential_alerts',
      'credential_deliveries',
      'host_credentials',
      'host_renewals',
      'idempotency_keys',
      'job_events',
      'job_launch_attachments',
      'job_turns',
      'jobs',
      'oauth_clients',
      'operator_scope_events',
      'operator_token_calls',
      'operator_tokens',
      'refresh_tokens',
      'thread_action_events',
      'token_families',
      'webhook_archive',
      'webhook_attempts',
      'webhook_deliveries',
      'webhook_health',
      'webhook_job_bindings',
      'webhook_subscriptions',
    ]);
  });

  test('migrations are idempotent and refuse a newer schema', (t) => {
    const path = join(tempDir(t), 'test.db');
    openDatabase(path).close();
    const db = openDatabase(path);
    t.after(() => db.close());
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(db), { code: 'database_error' });
  });

  test('migration 2 keeps the jobs, events and request ids of a version 1 database', (t) => {
    const path = join(openDataDir(join(tempDir(t), 'data')).databasePath);
    const v1 = new DatabaseSync(path);
    v1.exec('PRAGMA foreign_keys = ON');
    migrate(v1, MIGRATIONS.slice(0, 1));
    assert.equal(schemaVersion(v1), 1);
    v1.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
         t3_thread_id, t3_thread_title, t3_thread_link, last_run_id, pending_request_ids, latest_message_excerpt, latest_activity_at,
         read_position, host_unreachable_since, last_error_code, last_error_message, created_at, updated_at, state_changed_at,
         dispatch_started_at, finished_at)
       VALUES ('jobfull0001', 'client-a', 'req-1', 'pilot', 'main', 'project-1', 'idle', 'synthetic task', 'Synthetic [job:jobfull0001]',
         'fleet/jobfull0001', 'auto', 'thread-1', 'Synthetic [job:jobfull0001]', 't3-thread://v1/env-synthetic/thread-1', 'thread-1-run-1',
         '["request-1"]', 'synthetic excerpt', 5, 7, NULL, 't3_run_failed', 'synthetic message', 1, 2, 3, 4, NULL)`,
    ).run();
    v1.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at, finished_at)
       VALUES ('jobdone0002', 'client-b', 'req-2', 'docs', 'main', 'cancelled', 'synthetic', 't', 'b', 'approval-required', 10, 11, 12, 12)`,
    ).run();
    v1.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('jobfull0001', 'created', 'queued', 1)").run();
    v1.prepare("INSERT INTO job_events (job_id, type, from_state, to_state, detail, created_at) VALUES ('jobfull0001', 'state_changed', 'running', 'idle', '{\"reason\":\"completed\"}', 3)").run();
    v1.prepare("INSERT INTO idempotency_keys (client_id, request_id, tool, input_hash, job_id, response, created_at) VALUES ('client-a', 'req-1', 'work_start', 'h', 'jobfull0001', NULL, 1)").run();
    const before = v1.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => ({ ...row }));
    const eventsBefore = v1.prepare('SELECT * FROM job_events ORDER BY id').all();
    v1.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 21);
    const after = db.prepare('SELECT * FROM jobs ORDER BY rowid').all() as Record<string, unknown>[];
    assert.deepEqual(
      after.map(
        ({ standing, delegated_work, activity_position, delegated_untracked, delegated_untracked_run_id, delegated_ended_at, latest_message_truncated, launch_spec, workspace_kind, workspace_root_key, workspace_root_held_at, workspace_resume_tokens, probe_attempts, probe_retry_at, pull_requests, pull_requests_checked_at, origin, adopted_by, adopted_at, ...rest }) =>
          rest,
      ),
      before,
      'every row and column is copied as it was',
    );
    assert.deepEqual(after.map((row) => [row.standing, row.delegated_work, row.activity_position]), [[0, '[]', null], [0, '[]', null]]);
    assert.deepEqual(db.prepare('SELECT * FROM job_events ORDER BY id').all(), eventsBefore);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number }).n, 1);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1, 'foreign keys are enforced again');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.throws(() => db.prepare("INSERT INTO job_events (job_id, type, created_at) VALUES ('nojob', 'x', 0)").run(), /FOREIGN KEY/);
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/, 'the job_events triggers survive');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    assert.deepEqual(indexes, ['jobs_host_state', 'jobs_host_thread', 'jobs_project_created', 'jobs_state', 'jobs_thread', 'jobs_workspace_root', 'jobs_workspace_root_held']);
    db.prepare("UPDATE jobs SET state = 'released', standing = 1 WHERE id = 'jobfull0001'").run();
    assert.throws(() => db.prepare("UPDATE jobs SET state = 'paused' WHERE id = 'jobfull0001'").run(), /CHECK/);
    assert.throws(() => db.prepare("UPDATE jobs SET standing = 2 WHERE id = 'jobfull0001'").run(), /CHECK/);

    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('jobs', 'job_events') ORDER BY name").all();
    assert.deepEqual(schema(db), schema(fresh), 'a migrated database has the schema of a new one');
  });

  test('migration 2 copies a version 1 jobs table from an earlier build of migration 1', (t) => {
    // Before migration 1 reached main it was corrected in place: databases created by earlier builds
    // have no state_changed_at or t3_thread_link, and store read_position as text.
    const path = join(openDataDir(join(tempDir(t), 'data')).databasePath);
    const v1 = new DatabaseSync(path);
    migrate(v1, MIGRATIONS.slice(0, 1));
    v1.exec(`
DROP TABLE jobs;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, request_id TEXT NOT NULL, project_alias TEXT NOT NULL, host_id TEXT NOT NULL,
  t3_project_id TEXT, state TEXT NOT NULL, task TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, runtime_mode TEXT NOT NULL,
  t3_thread_id TEXT, t3_thread_title TEXT, last_run_id TEXT, pending_request_ids TEXT NOT NULL DEFAULT '[]', latest_message_excerpt TEXT,
  latest_activity_at INTEGER, read_position TEXT, host_unreachable_since INTEGER, last_error_code TEXT, last_error_message TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dispatch_started_at INTEGER, finished_at INTEGER
) STRICT;`);
    const insert = v1.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, t3_thread_id, read_position, created_at, updated_at)
       VALUES (?, 'client-a', ?, 'pilot', 'main', 'idle', 'synthetic task', 'Synthetic', 'fleet/x', 'auto', 'thread-1', ?, 1, ?)`,
    );
    insert.run('jobolder001', 'req-1', '42', 20);
    insert.run('jobolder002', 'req-2', 'not a position', 30);
    insert.run('jobolder003', 'req-3', null, 40);
    insert.run('jobolder004', 'req-4', ' 7 ', 50);
    v1.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('jobolder001', 'created', 'queued', 1)").run();
    v1.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const rows = db.prepare('SELECT id, read_position, typeof(read_position) AS type, state_changed_at, t3_thread_link, standing FROM jobs ORDER BY rowid').all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { id: 'jobolder001', read_position: 42, type: 'integer', state_changed_at: 20, t3_thread_link: null, standing: 0 },
        { id: 'jobolder002', read_position: null, type: 'null', state_changed_at: 30, t3_thread_link: null, standing: 0 },
        { id: 'jobolder003', read_position: null, type: 'null', state_changed_at: 40, t3_thread_link: null, standing: 0 },
        { id: 'jobolder004', read_position: 7, type: 'integer', state_changed_at: 50, t3_thread_link: null, standing: 0 },
      ],
    );
    assert.equal(new JobStore(db, () => 1_000, silentLogger).require('jobolder001').readPosition, 42);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM job_events').get() as { n: number }).n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'jobs' ORDER BY name").all();
    assert.deepEqual(schema(db), schema(fresh), 'the same schema as a new database');
  });

  test('migration 4 adds the activity position to a version 3 database, keeping its jobs', (t) => {
    const path = join(openDataDir(join(tempDir(t), 'data')).databasePath);
    const v3 = new DatabaseSync(path);
    v3.exec('PRAGMA foreign_keys = ON');
    migrate(v3, MIGRATIONS.slice(0, 3));
    assert.equal(schemaVersion(v3), 3);
    v3.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, t3_thread_id,
         read_position, created_at, updated_at, state_changed_at, standing, delegated_work)
       VALUES ('jobstand001', 'operator', 'adopted', 'pilot', 'main', 'idle', '', 'Synthetic coordinator', '', '', 'thread-1', 12, 1, 2, 3, 1,
         '[{"itemId":"item-4","position":4,"title":"Synthetic task"}]')`,
    ).run();
    v3.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('jobstand001', 'created', 'idle', 1)").run();
    const before = v3.prepare('SELECT * FROM jobs').all().map((row) => ({ ...row }));
    v3.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const after = (db.prepare('SELECT * FROM jobs').all() as Record<string, unknown>[]).map(
      ({ activity_position, delegated_untracked, delegated_untracked_run_id, delegated_ended_at, latest_message_truncated, launch_spec, workspace_kind, workspace_root_key, workspace_root_held_at, workspace_resume_tokens, probe_attempts, probe_retry_at, pull_requests, pull_requests_checked_at, origin, adopted_by, adopted_at, ...rest }) => [activity_position, rest],
    );
    assert.deepEqual(after, before.map((row) => [null, row]), 'existing jobs keep every column and have no activity position yet');
    const store = new JobStore(db, () => 1_000, silentLogger);
    const job = store.require('jobstand001');
    assert.deepEqual([job.readPosition, job.activityPosition, job.delegatedWork.length], [12, null, 1]);
    store.update(job.id, { activityPosition: 40 });
    assert.equal(store.require(job.id).activityPosition, 40);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'jobs' ORDER BY name").all();
    assert.deepEqual(schema(db), schema(fresh), 'the same schema as a new database');
  });

  test('migration 5 adds the delegated work bounds to a version 4 database, keeping its jobs', (t) => {
    const path = join(openDataDir(join(tempDir(t), 'data')).databasePath);
    const v4 = new DatabaseSync(path);
    v4.exec('PRAGMA foreign_keys = ON');
    migrate(v4, MIGRATIONS.slice(0, 4));
    assert.equal(schemaVersion(v4), 4);
    v4.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, t3_thread_id,
         read_position, created_at, updated_at, state_changed_at, standing, delegated_work, activity_position)
       VALUES ('jobstand001', 'operator', 'adopted', 'pilot', 'main', 'idle', '', 'Synthetic coordinator', '', '', 'thread-1', 12, 1, 2, 3, 1,
         '[{"itemId":"item-4","position":4,"title":"Synthetic task"}]', 20)`,
    ).run();
    v4.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('jobstand001', 'created', 'idle', 1)").run();
    const before = v4.prepare('SELECT * FROM jobs').all().map((row) => ({ ...row }));
    v4.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const after = (db.prepare('SELECT * FROM jobs').all() as Record<string, unknown>[]).map(
      ({ delegated_untracked, delegated_untracked_run_id, delegated_ended_at, latest_message_truncated, launch_spec, workspace_kind, workspace_root_key, workspace_root_held_at, workspace_resume_tokens, probe_attempts, probe_retry_at, pull_requests, pull_requests_checked_at, origin, adopted_by, adopted_at, ...rest }) => [[delegated_untracked, delegated_untracked_run_id, delegated_ended_at], rest],
    );
    assert.deepEqual(after, before.map((row) => [[0, null, null], row]), 'existing jobs keep every column, with nothing untracked or ended');
    const store = new JobStore(db, () => 1_000, silentLogger);
    const job = store.require('jobstand001');
    assert.deepEqual([job.delegatedWork.length, job.activityPosition, job.delegatedUntracked, job.delegatedEndedAt], [1, 20, 0, null]);
    store.update(job.id, { delegatedUntracked: 3, delegatedUntrackedRunId: 'run-2', delegatedEndedAt: 900 });
    const updated = store.require(job.id);
    assert.deepEqual([updated.delegatedUntracked, updated.delegatedUntrackedRunId, updated.delegatedEndedAt], [3, 'run-2', 900]);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'jobs' ORDER BY name").all();
    assert.deepEqual(schema(db), schema(fresh), 'the same schema as a new database');
  });

  test('migration 6 adds the excerpt truncated flag to a version 5 database, marking excerpts at the old bound', (t) => {
    const path = join(openDataDir(join(tempDir(t), 'data')).databasePath);
    const v5 = new DatabaseSync(path);
    v5.exec('PRAGMA foreign_keys = ON');
    migrate(v5, MIGRATIONS.slice(0, 5));
    assert.equal(schemaVersion(v5), 5);
    const insert = v5.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, t3_thread_id,
         latest_message_excerpt, read_position, created_at, updated_at, state_changed_at, standing)
       VALUES (?, 'operator', 'adopted', 'pilot', 'main', 'idle', '', 'Synthetic coordinator', '', '', ?, ?, 12, 1, 2, 3, 1)`,
    );
    insert.run('jobshort001', 'thread-1', 'Synthetic short reply');
    insert.run('jobfull0001', 'thread-2', 'x'.repeat(2000));
    insert.run('jobnear0001', 'thread-3', 'x'.repeat(1999));
    insert.run('jobnone0001', 'thread-4', null);
    v5.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('jobfull0001', 'created', 'idle', 1)").run();
    const before = v5.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => ({ ...row }));
    v5.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const after = (db.prepare('SELECT * FROM jobs ORDER BY rowid').all() as Record<string, unknown>[]).map(
      ({ latest_message_truncated, launch_spec, workspace_kind, workspace_root_key, workspace_root_held_at, workspace_resume_tokens, probe_attempts, probe_retry_at, pull_requests, pull_requests_checked_at, origin, adopted_by, adopted_at, ...rest }) => [latest_message_truncated, rest],
    );
    assert.deepEqual(after, before.map((row, index) => [[0, 1, 1, 0][index], row]), 'existing jobs keep every column; excerpts at the bound are cut');
    const store = new JobStore(db, () => 1_000, silentLogger);
    assert.deepEqual([store.require('jobshort001').latestMessageTruncated, store.require('jobfull0001').latestMessageTruncated], [false, true]);
    store.update('jobshort001', { latestMessageExcerpt: 'Synthetic longer reply', latestMessageTruncated: true });
    assert.equal(store.require('jobshort001').latestMessageTruncated, true);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'jobs' ORDER BY name").all();
    assert.deepEqual(schema(db), schema(fresh), 'the same schema as a new database');
  });

  test('migration 7 retains a populated version 6 database and leaves separate auth success times unknown', (t) => {
    const path = openDataDir(join(tempDir(t), 'data')).databasePath;
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys = ON');
    migrate(old, MIGRATIONS.slice(0, 6));
    old.exec(`
      INSERT INTO oauth_clients (id, name, redirect_uris, created_at, last_used_at) VALUES ('client-1', 'Synthetic agent', '[]', 1, 42);
      INSERT INTO token_families (id, client_id, scope, resource, created_at, revoked_at, revoked_reason)
        VALUES ('family-1', 'client-1', 'fleet:read', 'https://gateway.example.com/mcp', 1, 3, 'refresh_token_reuse');
      INSERT INTO refresh_tokens (token_hash, family_id, scope, created_at, expires_at, rotated_at)
        VALUES ('synthetic-refresh-hash', 'family-1', 'fleet:read', 1, 9000, 2);
      INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
        VALUES ('synthetic-access-hash', 'family-1', 'synthetic-refresh-hash', 'fleet:read', 1, 1000);
      INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode,
        created_at, updated_at, state_changed_at, activity_position, latest_message_truncated)
        VALUES ('job-1', 'client-1', 'request-1', 'pilot', 'main', 'idle', 'Synthetic task', 'Synthetic title', 'synthetic/branch', 'auto',
          1, 2, 2, 7, 1);
      INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('job-1', 'created', 'idle', 1);
      INSERT INTO idempotency_keys (client_id, tool, request_id, input_hash, job_id, created_at)
        VALUES ('client-1', 'work_start', 'request-1', 'synthetic-request-hash', 'job-1', 1);
    `);
    const tables = ['token_families', 'refresh_tokens', 'access_tokens', 'jobs', 'job_events', 'idempotency_keys'];
    const clientsBefore = old.prepare('SELECT * FROM oauth_clients').all();
    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row })));
    old.close();
    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.deepEqual(
      tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => {
        // Migration 8 adds launch_spec to jobs, NULL for every existing row.
        const { launch_spec, workspace_kind, workspace_root_key, workspace_root_held_at, workspace_resume_tokens, probe_attempts, probe_retry_at, pull_requests, pull_requests_checked_at, origin, adopted_by, adopted_at, ...rest } = { ...row } as Record<string, unknown>;
        if (table === 'jobs') assert.equal(launch_spec, null);
        return table === 'jobs' ? rest : { ...row };
      })),
      before,
    );
    const clients = db.prepare('SELECT * FROM oauth_clients').all().map(({ last_mcp_success_at, last_refresh_success_at, ...rest }) => {
      assert.equal(last_mcp_success_at, null);
      assert.equal(last_refresh_success_at, null);
      return rest;
    });
    assert.deepEqual(clients, clientsBefore.map((row) => ({ ...row })), 'mixed last_used_at is retained, never fabricated into success');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE job_events SET type = 'changed'").run(), /append-only/);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    assert.deepEqual(schema(db), schema(fresh));
  });

  test('migration 8 adds the launch spec to a populated version 7 database, keeping jobs, standing jobs, events, credentials and keys', (t) => {
    const path = openDataDir(join(tempDir(t), 'data')).databasePath;
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys = ON');
    migrate(old, MIGRATIONS.slice(0, 7));
    assert.equal(schemaVersion(old), 7);
    old.exec(`
      INSERT INTO oauth_clients (id, name, redirect_uris, created_at, last_used_at, last_mcp_success_at) VALUES ('client-1', 'Synthetic agent', '[]', 1, 42, 50);
      INSERT INTO token_families (id, client_id, scope, resource, created_at) VALUES ('family-1', 'client-1', 'fleet:operate', 'https://gateway.example.com/mcp', 1);
      INSERT INTO refresh_tokens (token_hash, family_id, scope, created_at, expires_at) VALUES ('synthetic-refresh-hash', 'family-1', 'fleet:operate', 1, 9000);
      INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
        VALUES ('synthetic-access-hash', 'family-1', 'synthetic-refresh-hash', 'fleet:operate', 1, 1000);
      INSERT INTO host_credentials (host_id, t3_client_id, access_token, scope, access, issued_at, expires_at, verified_at)
        VALUES ('main', 'synthetic-t3-client', 'synthetic-t3-token', 'orchestration', 'full-access', 1, 9000, 1);
      INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
        created_at, updated_at, state_changed_at, activity_position, latest_message_truncated)
        VALUES ('jobqueue001', 'client-1', 'request-1', 'pilot', 'main', NULL, 'queued', 'Synthetic task', 'Synthetic title [job:jobqueue001]', 'fleet/jobqueue001', 'auto',
          1, 2, 2, NULL, 0);
      INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode, t3_thread_id,
        created_at, updated_at, state_changed_at, standing, activity_position, read_position)
        VALUES ('jobstand001', 'operator', 'adopted', 'pilot', 'main', 'project-1', 'idle', '', 'Synthetic coordinator', '', '', 'thread-1',
          1, 2, 3, 1, 20, 12);
      INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('jobqueue001', 'created', 'queued', 1);
      INSERT INTO job_events (job_id, type, to_state, detail, created_at) VALUES ('jobstand001', 'created', 'idle', '{"reason":"adopted"}', 1);
      INSERT INTO idempotency_keys (client_id, tool, request_id, input_hash, job_id, created_at)
        VALUES ('client-1', 'work_start', 'request-1', 'synthetic-request-hash', 'jobqueue001', 1);
    `);
    const tables = ['oauth_clients', 'token_families', 'refresh_tokens', 'access_tokens', 'host_credentials', 'job_events', 'idempotency_keys'];
    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const jobsBefore = old.prepare('SELECT * FROM jobs ORDER BY rowid').all().map((row) => ({ ...row }));
    old.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.deepEqual(tables.map((table) => rowsWithoutV12(db, table)), before);
    const jobs = (db.prepare('SELECT * FROM jobs ORDER BY rowid').all() as Record<string, unknown>[]).map(({ launch_spec, workspace_kind, workspace_root_key, workspace_root_held_at, workspace_resume_tokens, probe_attempts, probe_retry_at, pull_requests, pull_requests_checked_at, origin, adopted_by, adopted_at, ...rest }) => [launch_spec, rest]);
    assert.deepEqual(jobs, jobsBefore.map((row) => [null, row]), 'existing jobs keep every column and have no launch spec');
    const store = new JobStore(db, () => 1_000, silentLogger);
    assert.deepEqual([store.require('jobqueue001').launchSpec, store.require('jobstand001').launchSpec, store.require('jobstand001').standing], [null, null, true]);
    const spec = {
      v: 1 as const, projectId: 'project-9', projectName: 'Synthetic discovered', source: 'discovered' as const, alias: null,
      baseRef: 'main', runtimeMode: 'approval-required' as const, model: { source: 'explicit' as const, selection: { instanceId: 'synthetic-provider', model: 'synthetic-model' } },
    };
    store.create({
      id: 'jobspec0001', clientId: 'client-1', requestId: 'request-2', inputHash: 'h2', projectAlias: '@main/project-9', hostId: 'main',
      task: 'Synthetic', title: 'Synthetic [job:jobspec0001]', branch: 'fleet/jobspec0001', runtimeMode: 'approval-required', t3ProjectId: 'project-9', launchSpec: spec,
    });
    assert.deepEqual([store.require('jobspec0001').launchSpec, store.require('jobspec0001').t3ProjectId], [spec, 'project-9']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    assert.deepEqual(schema(db), schema(fresh));
  });

  test('migration 10 preserves populated version 9 queues, leases, secrets and revisions with config ownership and unknown test results', (t) => {
    const path = openDataDir(join(tempDir(t), 'data')).databasePath;
    const old = new DatabaseSync(path);
    migrate(old, MIGRATIONS.slice(0, 9));
    assert.equal(schemaVersion(old), 9);
    old.exec(`
      INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode,
        created_at, updated_at, state_changed_at)
        VALUES ('jobold0001', 'synthetic-client', 'r1', 'pilot', 'main', 'idle', 'Synthetic task', 'Synthetic job', 'fleet/old', 'auto', 1, 2, 2);
      INSERT INTO job_events (id, job_id, type, from_state, to_state, created_at) VALUES (1, 'jobold0001', 'state_changed', 'running', 'idle', 2);
      INSERT INTO job_turns (job_id, run_id, client_id) VALUES ('jobold0001', 'run-1', 'synthetic-client');
      INSERT INTO webhook_subscriptions (id, revision, identity, settings, route, overflow_count, overflow_sequence, overflow_at, overflow_reason)
        VALUES ('old-route', 'original-revision', 'original-identity', '{"events":["idle"],"excerptChars":0}',
          '{"url":"https://receiver.example.com/synthetic-private-path","header":"authorization","value":"Bearer synthetic-private-key"}',
          4, 1, 2, 'backlog');
      INSERT INTO webhook_deliveries (id, subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at,
        next_attempt_at, state, attempt_count, lease, lease_until)
        VALUES (1, 'old-route', 'original-revision', 'event-1', 1, '{"synthetic":"immutable payload"}', 2, 3600002, 2, 'sending', 1, 'lease-1', 30002);
      INSERT INTO webhook_deliveries (id, subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
        VALUES (2, 'old-route', 'original-revision', 'event-2', 1, '{"synthetic":"pending payload"}', 2, 3600002, 2, 'pending');
      INSERT INTO webhook_attempts (subscription_id, delivery_id, event_id, attempted_at, outcome, lease)
        VALUES ('old-route', 1, 'event-1', 2, 'in_progress', 'lease-1');
      INSERT INTO webhook_attempts (subscription_id, event_id, attempted_at, status_code, outcome)
        VALUES ('old-route', 'old-ping', 1, 204, 'delivered');
    `);
    const tables = ['jobs', 'job_events', 'job_turns', 'webhook_deliveries', 'webhook_attempts'];
    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const subscriptions = old.prepare('SELECT * FROM webhook_subscriptions ORDER BY id').all().map((row) => ({ ...row }));
    old.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.deepEqual(tables.map((table) => rowsWithoutV12(db, table)), before);
    const migrated = db.prepare('SELECT * FROM webhook_subscriptions ORDER BY id').all()
      .map(({ source, last_test_at, last_test_outcome, last_test_status_code, ...rest }) =>
        ({ source, last_test_at, last_test_outcome, last_test_status_code, original: rest }));
    assert.deepEqual(migrated, subscriptions.map((original) =>
      ({ source: 'config', last_test_at: null, last_test_outcome: null, last_test_status_code: null, original })));
    assert.throws(() => db.prepare("UPDATE webhook_subscriptions SET source = 'unknown'").run(), /CHECK constraint/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/);
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: typeof db) => target.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    assert.deepEqual(schema(db), schema(fresh));
  });

  test('migration 11 keeps a populated version 10 ledger as it was and bars older builds from version 2 launch specs', (t) => {
    const path = openDataDir(join(tempDir(t), 'data')).databasePath;
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys = ON');
    migrate(old, MIGRATIONS.slice(0, 10));
    assert.equal(schemaVersion(old), 10);
    const store = new JobStore(old, () => 1_000, silentLogger);
    const worktree = {
      v: 1, projectId: 'project-1', projectName: 'Synthetic worktree', source: 'alias', alias: 'pilot', baseRef: 'main',
      runtimeMode: 'auto', model: { source: 't3_default', selection: null },
    } satisfies LaunchSpec;
    const job = { clientId: 'c', requestId: 'r', inputHash: 'h', projectAlias: 'pilot', hostId: 'main', task: 'Synthetic', title: 'Synthetic', branch: 'fleet/wt', runtimeMode: 'auto' };
    store.create({ ...job, id: 'legacy0001', launchSpec: worktree });
    store.create({ ...job, id: 'legacy0002', requestId: 'r2' });
    old.exec(`
      INSERT INTO host_credentials (host_id, t3_client_id, access_token, scope, access, issued_at, expires_at, verified_at)
        VALUES ('main', 'synthetic-client', 'synthetic-token', 'orchestration', 'full-access', 1, 10000, 1);
      INSERT INTO job_turns (job_id, run_id, client_id) VALUES ('legacy0001', 'run-1', 'c');
      INSERT INTO webhook_subscriptions (id, revision, identity, settings, route, source, last_test_at, last_test_outcome, last_test_status_code)
        VALUES ('old-route', 'original-revision', 'original-identity', '{"events":["idle"],"excerptChars":0}',
          '{"url":"https://receiver.example.com/synthetic-private-path","header":"authorization","value":"Bearer synthetic-private-key"}',
          'dashboard', 5, 'delivered', 204);
      INSERT INTO webhook_deliveries (id, subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at,
        next_attempt_at, state, attempt_count, lease, lease_until)
        VALUES (1, 'old-route', 'original-revision', 'event-1', 1, '{"synthetic":"immutable payload"}', 2, 3600002, 2, 'sending', 1, 'lease-1', 30002);
      INSERT INTO webhook_deliveries (id, subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
        VALUES (2, 'old-route', 'original-revision', 'event-2', 2, '{"synthetic":"pending payload"}', 2, 3600002, 2, 'pending');
      INSERT INTO webhook_attempts (subscription_id, delivery_id, event_id, attempted_at, outcome, lease)
        VALUES ('old-route', 1, 'event-1', 2, 'in_progress', 'lease-1');
    `);
    const schema = (target: DatabaseSync) => target.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    const tables = ['jobs', 'job_events', 'idempotency_keys', 'host_credentials', 'job_turns', 'webhook_subscriptions', 'webhook_deliveries', 'webhook_attempts'];
    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    assert.ok(before.every((rows) => rows.length > 0), 'every table that holds state is populated');
    const schemaBefore = schema(old);
    old.close();

    // Migration 12 has its own test below: this one stops at the barrier.
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    t.after(() => db.close());
    migrate(db, MIGRATIONS.slice(0, 11));
    assert.equal(schemaVersion(db), 11);
    assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before, 'no row changes');
    assert.deepEqual(schema(db), schemaBefore, 'the barrier changes the version and nothing else');
    const migrated = new JobStore(db, () => 2_000, silentLogger);
    assert.deepEqual(migrated.require('legacy0001').launchSpec, worktree);
    assert.equal(migrated.require('legacy0002').launchSpec, null);
    const scratch = {
      v: 2, projectId: 'scratch-id', projectName: null, source: 'alias', alias: 'scratch', hostId: 'main',
      workspace: { kind: 'scratch' }, defaultProject: 'scratch', runtimeMode: 'auto', model: { source: 'host', selection: { model: 'synthetic-model' } },
    } satisfies LaunchSpec;
    migrated.create({ ...job, id: 'scratch001', requestId: 'r3', branch: '', t3ProjectId: 'scratch-id', launchSpec: scratch });
    assert.deepEqual(migrated.require('scratch001').launchSpec, scratch);
    // An older build stops at the schema version, before its parser can read the v2 record as no spec at all
    // (a worktree launch of what was meant to run in T3's scratch workspace).
    assert.throws(() => migrate(db, MIGRATIONS.slice(0, 10)), /schema version 11 is newer than this build supports \(10\)/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/);
    const fresh = new DatabaseSync(join(tempDir(t), 'fresh.db'));
    fresh.exec('PRAGMA foreign_keys = ON');
    t.after(() => fresh.close());
    migrate(fresh, MIGRATIONS.slice(0, 11));
    assert.deepEqual(schema(db), schema(fresh));
  });

  test('migration 12 keeps a populated version 11 ledger as it was, adds the reservation columns and bars older builds', (t) => {
    const path = openDataDir(join(tempDir(t), 'data')).databasePath;
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys = ON');
    migrate(old, MIGRATIONS.slice(0, 11));
    assert.equal(schemaVersion(old), 11);
    const store11 = new JobStore(old, () => 1_000, silentLogger);
    const job = { clientId: 'c', requestId: 'r', inputHash: 'h', projectAlias: 'pilot', hostId: 'main', task: 'Synthetic', title: 'Synthetic', branch: 'fleet/wt', runtimeMode: 'auto' };
    store11.create({ ...job, id: 'legacy0001' });
    store11.create({ ...job, id: 'legacy0002', requestId: 'r2', t3ProjectId: 'project-1', launchSpec: {
      v: 1, projectId: 'project-1', projectName: 'Synthetic', source: 'alias', alias: 'pilot', baseRef: 'main', runtimeMode: 'auto', model: { source: 't3_default', selection: null },
    } });
    old.exec("UPDATE jobs SET state = 'running' WHERE id = 'legacy0001'");
    const before = ['jobs', 'job_events', 'idempotency_keys'].map((table) => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    old.close();

    const db = openDatabase(path);
    t.after(() => db.close());
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 21);
    assert.deepEqual(['jobs', 'job_events', 'idempotency_keys'].map((table) => rowsWithoutV12(db, table)), before, 'no existing column changes');
    const added = db.prepare('SELECT workspace_kind, workspace_root_key, workspace_root_held_at, workspace_resume_tokens, probe_attempts, probe_retry_at FROM jobs ORDER BY rowid').all().map((row) => ({ ...row }));
    assert.deepEqual(added, Array(2).fill({ workspace_kind: null, workspace_root_key: null, workspace_root_held_at: null, workspace_resume_tokens: '[]', probe_attempts: 0, probe_retry_at: null }));
    const migrated = new JobStore(db, () => 2_000, silentLogger);
    assert.equal(migrated.require('legacy0002').launchSpec?.v, 1);
    assert.equal(migrated.require('legacy0001').workspaceKind, null);
    // The ledger itself refuses a second holder of one folder on a host, and nothing else about holding.
    const hold = (id: string, key: string | null) =>
      db.prepare('UPDATE jobs SET workspace_kind = ?, workspace_root_key = ?, workspace_root_held_at = ? WHERE id = ?').run(key ? 'root' : null, key, key ? 1 : null, id);
    hold('legacy0001', 'folder-a');
    assert.throws(() => hold('legacy0002', 'folder-a'), /UNIQUE/);
    db.prepare("UPDATE jobs SET host_id = 'other' WHERE id = 'legacy0002'").run();
    hold('legacy0002', 'folder-a');
    assert.throws(() => db.prepare("UPDATE jobs SET workspace_kind = 'checkout' WHERE id = 'legacy0001'").run(), /CHECK/);
    assert.throws(() => migrate(db, MIGRATIONS.slice(0, 11)), /schema version 21 is newer than this build supports \(11\)/);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    const fresh = openDatabase(join(tempDir(t), 'fresh.db'));
    t.after(() => fresh.close());
    const schema = (target: DatabaseSync) => target.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    assert.deepEqual(schema(db), schema(fresh));
  });

  test('migration 2 names a missing column it cannot fill and leaves the database at version 1', (t) => {
    const path = join(tempDir(t), 'test.db');
    const v1 = new DatabaseSync(path);
    migrate(v1, MIGRATIONS.slice(0, 1));
    v1.exec('PRAGMA foreign_keys = OFF; DROP TABLE jobs; CREATE TABLE jobs (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL) STRICT;');
    assert.throws(() => migrate(v1), { code: 'database_error', message: /^Migration 2 \(standing jobs\): table jobs has no column client_id/ });
    assert.equal(schemaVersion(v1), 1);
    v1.close();
  });

  test('a migration that fails in SQLite is a database_error naming it; a busy database says so', (t) => {
    const path = join(tempDir(t), 'test.db');
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    migrate(db);
    const broken = { version: SCHEMA_VERSION + 1, name: 'synthetic broken', sql: 'ALTER TABLE no_such_table ADD COLUMN x TEXT;' };
    assert.throws(() => migrate(db, [...MIGRATIONS, broken]), {
      code: 'database_error',
      message: new RegExp(`^Migration ${SCHEMA_VERSION + 1} \\(synthetic broken\\) failed: no such table: no_such_table\\. It was rolled back; the schema is still at version ${SCHEMA_VERSION}\\.`),
    });
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    const other = new DatabaseSync(path);
    t.after(() => other.close());
    other.exec('BEGIN IMMEDIATE');
    db.exec('PRAGMA busy_timeout = 0');
    const next = { version: SCHEMA_VERSION + 1, name: 'synthetic next', sql: 'CREATE TABLE synthetic_next (x TEXT) STRICT;' };
    assert.throws(() => migrate(db, [...MIGRATIONS, next]), {
      code: 'database_error',
      message: new RegExp(`^Migration ${SCHEMA_VERSION + 1} \\(synthetic next\\) could not run: another process is using the database \\(SQLITE_BUSY\\)`),
    });
    other.exec('ROLLBACK');
    migrate(db, [...MIGRATIONS, next]);
    assert.equal(schemaVersion(db), SCHEMA_VERSION + 1);
  });

  test('a table rebuild that breaks a foreign key is rolled back', (t) => {
    const db = openDatabase(join(tempDir(t), 'test.db'));
    t.after(() => db.close());
    db.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at)
       VALUES ('j1', 'c', 'r', 'p', 'h', 'queued', 't', 't', 'b', 'auto', 0, 0, 0)`,
    ).run();
    db.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('j1', 'created', 'queued', 0)").run();
    const broken = { version: SCHEMA_VERSION + 1, name: 'drops a job', rebuildsTables: true, sql: "DELETE FROM jobs WHERE id = 'j1';" };
    assert.throws(() => migrate(db, [...MIGRATIONS, broken]), { code: 'database_error', message: /broken foreign key/ });
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n, 1);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  });

  test('job_events is append-only', (t) => {
    const db = openDatabase(join(tempDir(t), 'test.db'));
    t.after(() => db.close());
    db.prepare(
      `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at)
       VALUES ('j1', 'c', 'r', 'p', 'h', 'queued', 't', 't', 'b', 'approval-required', 0, 0, 0)`,
    ).run();
    db.prepare("INSERT INTO job_events (job_id, type, to_state, created_at) VALUES ('j1', 'state', 'queued', 0)").run();
    assert.throws(() => db.prepare("UPDATE job_events SET type = 'x'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM job_events').run(), /append-only/);
  });

  test('the database file never contains the key file bytes', (t) => {
    const data = openDataDir(join(tempDir(t), 'data'));
    openDatabase(data.databasePath).close();
    assert.equal(readFileSync(data.databasePath).includes(data.key), false);
  });
});

describe('job store', () => {
  test('stores T3 read positions as integers and reads them back as numbers', (t) => {
    const db = openDatabase(openDataDir(join(tempDir(t), 'data')).databasePath);
    t.after(() => db.close());
    const store = new JobStore(db, () => 1_000, silentLogger);
    const job = { clientId: 'c', requestId: 'r', inputHash: 'h', projectAlias: 'pilot', hostId: 'main', task: 'synthetic', title: 't', branch: 'b', runtimeMode: 'auto' };
    store.create({ id: 'job1', ...job });
    assert.equal(store.require('job1').readPosition, null);
    store.update('job1', { readPosition: 42 });
    assert.equal(store.require('job1').readPosition, 42);
    assert.deepEqual({ ...(db.prepare('SELECT read_position AS p, typeof(read_position) AS type FROM jobs').get() as object) }, { p: 42, type: 'integer' });
    assert.throws(() => store.update('job1', { readPosition: 1.5 }), /INTEGER/);
    store.update('job1', { readPosition: null });
    assert.equal(store.require('job1').readPosition, null);
  });

  test('scopes request ids per agent and per tool', (t) => {
    const db = openDatabase(openDataDir(join(tempDir(t), 'data')).databasePath);
    t.after(() => db.close());
    const store = new JobStore(db, () => 1_000, silentLogger);
    const job = { clientId: 'c', requestId: 'shared', inputHash: 'h', projectAlias: 'pilot', hostId: 'main', task: 'synthetic', title: 't', branch: 'b', runtimeMode: 'auto' };
    assert.equal(store.create({ id: 'job1', ...job }).created, true);
    store.claimIdempotencyKey('c', 'work_continue', 'shared', { inputHash: 'other', jobId: 'job1' });
    assert.equal(store.idempotencyKey('c', 'work_start', 'shared')?.inputHash, 'h');
    assert.equal(store.idempotencyKey('c', 'work_continue', 'shared')?.inputHash, 'other');
    assert.deepEqual(store.create({ id: 'job2', ...job }), { job: store.require('job1'), created: false }, 'work_start replays unaffected');
  });

  test('adopts a thread once per project; a thread followed by another open job is refused', (t) => {
    const db = openDatabase(openDataDir(join(tempDir(t), 'data')).databasePath);
    t.after(() => db.close());
    const store = new JobStore(db, () => 1_000, silentLogger);
    const standing = {
      projectAlias: 'pilot', hostId: 'main', t3ProjectId: 'project-1', state: 'idle' as const, title: 'Synthetic coordinator', branch: '', runtimeMode: '',
      threadId: 'thread-1', threadTitle: 'Synthetic coordinator', threadLink: null, lastRunId: null, pendingRequestIds: [], latestMessageExcerpt: null,
      latestMessageTruncated: false, latestActivityAt: null, readPosition: 3, activityPosition: 9, lastErrorCode: null, lastErrorMessage: null, delegatedWork: [],
      delegatedUntracked: 4, delegatedUntrackedRunId: 'run-1',
    };
    const first = store.adopt({ id: 'job1', ...standing });
    assert.deepEqual(
      [first.created, first.job.standing, first.job.clientId, first.job.readPosition, first.job.activityPosition],
      [true, true, 'operator', 3, 9],
    );
    assert.deepEqual([first.job.delegatedUntracked, first.job.delegatedUntrackedRunId, first.job.delegatedEndedAt], [4, 'run-1', null]);
    assert.deepEqual(store.adopt({ id: 'job2', ...standing }), { job: first.job, created: false });
    assert.throws(() => store.adopt({ id: 'job3', ...standing, projectAlias: 'other' }), { code: 'job_state_conflict', message: /standing job job1 in project "pilot"/ });
    assert.deepEqual(store.recentEvents('job1', 5).map((event) => [event.type, event.fromState, event.toState, event.detail.reason]), [['created', null, 'idle', 'adopted']]);
    assert.deepEqual(store.standingJobs('pilot').map((job) => job.id), ['job1']);
    assert.deepEqual(store.standingJobs('other'), []);
  });

  test('a state change clears the delegated-work-ended mark; a finished job follows no delegated work', (t) => {
    const db = openDatabase(openDataDir(join(tempDir(t), 'data')).databasePath);
    t.after(() => db.close());
    const store = new JobStore(db, () => 1_000, silentLogger);
    const delegated = { delegatedWork: [{ itemId: 'item-4', position: 4, title: 'Synthetic task' }], delegatedUntracked: 2, delegatedUntrackedRunId: 'run-1' };
    const fields = (id: string) => {
      const job = store.require(id);
      return [job.state, job.delegatedWork.length, job.delegatedUntracked, job.delegatedUntrackedRunId, job.delegatedEndedAt];
    };
    for (const [id, to] of [['job1', 'released'], ['job2', 'cancelled'], ['job3', 'failed']] as const) {
      store.adopt({
        id, projectAlias: 'pilot', hostId: 'main', t3ProjectId: 'project-1', state: 'idle', title: 'Synthetic', branch: '', runtimeMode: '',
        threadId: `thread-${id}`, threadTitle: 'Synthetic', threadLink: null, lastRunId: null, pendingRequestIds: [], latestMessageExcerpt: null,
        latestMessageTruncated: false, latestActivityAt: null, readPosition: null, activityPosition: null, lastErrorCode: null, lastErrorMessage: null, ...delegated,
      });
      store.update(id, { delegatedEndedAt: 500 });
      assert.deepEqual(fields(id), ['idle', 1, 2, 'run-1', 500]);
      store.transition(id, { from: ['idle'], to, changes: delegated });
      assert.deepEqual(fields(id), [to, 0, 0, null, null], `cleared on ${to}`);
    }
    store.adopt({
      id: 'job4', projectAlias: 'pilot', hostId: 'main', t3ProjectId: 'project-1', state: 'idle', title: 'Synthetic', branch: '', runtimeMode: '',
      threadId: 'thread-job4', threadTitle: 'Synthetic', threadLink: null, lastRunId: null, pendingRequestIds: [], latestMessageExcerpt: null,
      latestMessageTruncated: false, latestActivityAt: null, readPosition: null, activityPosition: null, lastErrorCode: null, lastErrorMessage: null, ...delegated,
    });
    store.update('job4', { delegatedEndedAt: 500 });
    store.transition('job4', { from: ['idle'], to: 'idle', changes: { readPosition: 7 } });
    assert.equal(store.require('job4').delegatedEndedAt, 500, 'kept while the job stays idle');
    store.transition('job4', { from: ['idle'], to: 'running' });
    assert.deepEqual(fields('job4'), ['running', 1, 2, 'run-1', null], 'an open job keeps its delegated work');
  });
});

test('migration 13 preserves populated version 12 jobs and adds unknown PR snapshots', (t) => {
  const path = join(tempDir(t), 'pr-migration.db');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 12));
  db.exec(`INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode,
    created_at, updated_at, state_changed_at) VALUES ('legacypr01', 'c', 'r', 'pilot', 'main', 'idle', 'Synthetic', 'Synthetic', 'b', 'auto', 1, 2, 2)`);
  const before = db.prepare('SELECT * FROM jobs').get()!;
  migrate(db, MIGRATIONS.slice(0, 13));
  const after = db.prepare('SELECT * FROM jobs').get()!;
  const { pull_requests, pull_requests_checked_at, ...rest } = after;
  assert.equal(pull_requests, null);
  assert.equal(pull_requests_checked_at, null);
  assert.deepEqual(rest, { ...before });
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
});

test('migration 14 preserves version 13 jobs, grants and secrets, backfills provenance, and opts nobody in', (t) => {
  const db = new DatabaseSync(join(tempDir(t), 'adoption-migration.db'));
  t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 13));
  db.exec(`INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('client-a', 'Synthetic connector', '[]', 1);
INSERT INTO token_families (id, client_id, scope, resource, created_at) VALUES ('family-a', 'client-a', 'fleet:read fleet:operate', 'https://gateway.example/mcp', 1);
INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
  VALUES ('synthetic-hash', 'family-a', '', 'fleet:read fleet:operate', 1, 9000);
INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at, standing)
  VALUES ('legacy0001', 'client-a', 'r1', 'pilot', 'main', 'running', 'Synthetic', 'Synthetic', 'b', 'auto', 1, 2, 2, 0),
         ('legacy0002', 'operator', 'adopted', 'pilot', 'main', 'idle', '', 'Synthetic', '', 'auto', 3, 4, 4, 1);`);
  const tables = ['oauth_clients', 'token_families', 'access_tokens'];
  const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY id').all().map((row) => ({ ...row }));
  migrate(db);
  assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), before);
  const after = db.prepare('SELECT * FROM jobs ORDER BY id').all();
  assert.deepEqual(after.map(({ origin, adopted_by, adopted_at, ...rest }) => rest), jobs);
  assert.deepEqual(after.map((row) => [row.origin, row.adopted_by, row.adopted_at]), [['gateway', null, null], ['standing', 'operator', 3]]);
  assert.deepEqual(db.prepare('SELECT * FROM client_thread_scopes').all(), []);
  assert.deepEqual(db.prepare('SELECT * FROM operator_scope_events').all(), []);
  assert.throws(() => db.exec("INSERT INTO client_thread_scopes VALUES ('client-a', 'threads:unknown')"), /CHECK/);
  assert.throws(() => migrate(db, MIGRATIONS.slice(0, 13)), /newer than this build supports/);
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
});

test('migration 16 reopens only worker failures with threads and preserves settlement and history', (t) => {
  const db = new DatabaseSync(join(tempDir(t), 'recovery-migration.db'));
  t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 15));
  const insert = db.prepare(`INSERT INTO jobs
    (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode,
     created_at, updated_at, state_changed_at, finished_at, t3_thread_id, last_error_code)
    VALUES (?, 'client-a', ?, 'pilot', 'main', ?, 'Synthetic', 'Synthetic', 'b', 'auto', 1, 2, 2, 2, ?, ?)`);
  insert.run('recover', 'r1', 'failed', 'thread-a', 't3_run_failed');
  insert.run('missing', 'r2', 'failed', 'thread-b', 'thread_missing');
  insert.run('cancelled', 'r3', 'cancelled', 'thread-c', 't3_run_failed');
  insert.run('no-thread', 'r4', 'failed', null, 't3_run_failed');
  db.exec(`INSERT INTO job_events (job_id, type, from_state, to_state, created_at)
    VALUES ('recover', 'thread_settled', 'failed', 'failed', 3);`);
  const history = db.prepare('SELECT * FROM job_events').all();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT state, finished_at, last_error_code, updated_at FROM jobs WHERE id = ?').get('recover'),
    Object.assign(Object.create(null), { state: 'idle', finished_at: null, last_error_code: 't3_run_failed', updated_at: 2 }));
  assert.deepEqual(db.prepare("SELECT state FROM jobs WHERE id <> 'recover' ORDER BY id").all().map((r) => r.state),
    ['cancelled', 'failed', 'failed']);
  assert.deepEqual(db.prepare('SELECT * FROM job_events').all(), history);
  assert.throws(() => migrate(db, MIGRATIONS.slice(0, 15)), /newer than this build supports/);
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM job_events').all(), history);
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
});

test('migration 17 preserves populated version 16 jobs and adds private queued attachments', (t) => {
  const db = new DatabaseSync(join(tempDir(t), 'attachments-migration.db'));
  t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 16));
  db.exec(`INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode,
    created_at, updated_at, state_changed_at) VALUES ('legacyatt1', 'c', 'r', 'pilot', 'main', 'queued', 'Synthetic', 'Synthetic', 'b', 'auto', 1, 2, 2)`);
  const before = db.prepare('SELECT * FROM jobs').get()!;
  migrate(db);
  assert.deepEqual({ ...db.prepare('SELECT * FROM jobs').get()! }, { ...before });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_launch_attachments').get()!.n, 0);
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.throws(() => migrate(db, MIGRATIONS.slice(0, 16)), /newer than this build supports/);
});


test('migration 20 gives existing bearer tokens safe IDs without changing their grants or values', (t) => {
  const db = new DatabaseSync(join(tempDir(t), 'rotation.db'));
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS.slice(0, 19));
  db.exec(`INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('bot', 'Bot', '[]', 1);
    INSERT INTO token_families (id, client_id, scope, resource, created_at) VALUES ('grant', 'bot', 'fleet:read', 'https://gateway.example.com/mcp', 1);
    INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
      VALUES ('synthetic-hash', 'grant', '', 'fleet:read', 1, 9999);`);
  const before = db.prepare('SELECT * FROM access_tokens').all();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM access_tokens').all(), before);
  const metadata = db.prepare('SELECT * FROM operator_tokens').get()!;
  assert.match(metadata.id as string, /^[a-f0-9]{24}$/);
  assert.equal(metadata.last_used_at, null);
  assert.deepEqual(db.prepare('SELECT * FROM operator_token_calls').all(), []);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
