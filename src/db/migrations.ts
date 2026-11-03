import type { DatabaseSync } from 'node:sqlite';
import { GatewayError } from '../errors.ts';

export interface Migration {
  version: number;
  name: string;
  /** The migration's statements; or `run`, for a migration that must look at the database first. */
  sql?: string;
  run?: (db: DatabaseSync) => void;
  /**
   * The migration rebuilds a table that others reference (SQLite cannot alter a CHECK constraint):
   * it runs with foreign key enforcement off and must leave no violations (SQLite's documented
   * procedure for schema changes ALTER TABLE cannot make).
   */
  rebuildsTables?: boolean;
}

/**
 * Append-only list. Never edit a migration once it is in a commit on main: databases in use have
 * applied it. Add a new one. Times are Unix milliseconds. The jobs, job_events and idempotency_keys
 * tables are used by the job layer.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  counts_toward_limit INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX oauth_clients_created ON oauth_clients(created_at);

CREATE TABLE approval_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_client_id TEXT
) STRICT;

CREATE TABLE approval_failures (
  id INTEGER PRIMARY KEY,
  request_key TEXT NOT NULL,
  failed_at INTEGER NOT NULL,
  counts_globally INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX approval_failures_request ON approval_failures(request_key);
CREATE INDEX approval_failures_time ON approval_failures(failed_at);

CREATE TABLE authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  family_id TEXT
) STRICT;

CREATE TABLE token_families (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
) STRICT;
CREATE INDEX token_families_client ON token_families(client_id);

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES token_families(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  parent_hash TEXT,
  rotated_at INTEGER,
  superseded_at INTEGER
) STRICT;
CREATE INDEX refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX refresh_tokens_parent ON refresh_tokens(parent_hash);

CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES token_families(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX access_tokens_family ON access_tokens(family_id);
CREATE INDEX access_tokens_refresh ON access_tokens(refresh_token_hash);

CREATE TABLE host_credentials (
  host_id TEXT PRIMARY KEY,
  t3_client_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  access TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL
) STRICT;

CREATE TABLE host_renewals (
  host_id TEXT PRIMARY KEY,
  attempted_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  failed_at INTEGER,
  error_code TEXT,
  error_message TEXT
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  project_alias TEXT NOT NULL,
  host_id TEXT NOT NULL,
  t3_project_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'dispatching', 'running', 'needs_input', 'idle',
    'cancel_requested', 'cancelled', 'failed', 'unknown'
  )),
  task TEXT NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,
  t3_thread_id TEXT,
  t3_thread_title TEXT,
  t3_thread_link TEXT,
  last_run_id TEXT,
  pending_request_ids TEXT NOT NULL DEFAULT '[]',
  latest_message_excerpt TEXT,
  latest_activity_at INTEGER,
  read_position INTEGER,
  host_unreachable_since INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_changed_at INTEGER NOT NULL,
  dispatch_started_at INTEGER,
  finished_at INTEGER
) STRICT;
CREATE INDEX jobs_state ON jobs(state);
CREATE INDEX jobs_host_state ON jobs(host_id, state);
CREATE INDEX jobs_project_created ON jobs(project_alias, created_at DESC);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX job_events_job ON job_events(job_id, id);
CREATE TRIGGER job_events_append_only_update BEFORE UPDATE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
CREATE TRIGGER job_events_append_only_delete BEFORE DELETE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;

CREATE TABLE idempotency_keys (
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  response TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, tool, request_id)
) STRICT;
`,
  },
  {
    version: 2,
    name: 'standing jobs',
    rebuildsTables: true,
    // jobs gains `standing` (an existing T3 thread the operator adopted, rather than one the gateway
    // launched) and the terminal state `released` (the operator stopped tracking a standing job).
    // The state CHECK can only change by rebuilding the table; every row is copied (see rebuildJobsV2).
    run: rebuildJobsV2,
  },
  {
    version: 3,
    name: 'delegated work',
    // The subagent items (work delegated to other threads) a job's thread is still waiting on, as a
    // JSON array of { itemId, position, title }.
    sql: `ALTER TABLE jobs ADD COLUMN delegated_work TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    version: 4,
    name: 'activity position',
    // The read position in a thread's activity view (every timeline item), separate from read_position
    // in the messages view: delegated work shows only in the activity view. NULL reads from the start,
    // except on a standing job, which the watcher then scans as at adoption (jobs adopted before this).
    sql: `ALTER TABLE jobs ADD COLUMN activity_position INTEGER;`,
  },
  {
    version: 5,
    name: 'delegated work bounds',
    // delegated_untracked: running delegated tasks beyond the ones followed in delegated_work, counted
    // when they were cut; delegated_untracked_run_id: the thread's run when the last were cut (the count
    // is cleared once a later turn has finished). delegated_ended_at: when the delegated work of an idle
    // job ended without a new turn starting (cleared when the job changes state).
    sql: `
ALTER TABLE jobs ADD COLUMN delegated_untracked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN delegated_untracked_run_id TEXT;
ALTER TABLE jobs ADD COLUMN delegated_ended_at INTEGER;
`,
  },
  {
    version: 6,
    name: 'excerpt truncated',
    // latest_message_truncated: 1 when latest_message_excerpt stops short of the worker's message.
    // Existing excerpts are marked from their length (see addExcerptTruncated).
    run: addExcerptTruncated,
  },
  {
    version: 7,
    name: 'client authentication success times',
    // Old last_used_at mixes authentication attempts and token issuance; it cannot be backfilled honestly.
    sql: `ALTER TABLE oauth_clients ADD COLUMN last_mcp_success_at INTEGER;
          ALTER TABLE oauth_clients ADD COLUMN last_refresh_success_at INTEGER;`,
  },
  {
    version: 8,
    name: 'launch spec',
    // launch_spec: JSON (src/jobs/launchSpec.ts) recording what a job started through a direct target
    // or with an explicit model selection resolved to: T3 project id and name, configured or discovered
    // policy origin, alias, baseRef, runtimeMode, and the exact model selection with its source. NULL
    // for jobs from before this migration and for ordinary alias-only jobs, which dispatch as before.
    sql: `ALTER TABLE jobs ADD COLUMN launch_spec TEXT;`,
  },
  {
    version: 9,
    name: 'outbound webhooks and turn attribution',
    sql: `
CREATE TABLE job_turns (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  run_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  PRIMARY KEY (job_id, run_id)
) STRICT;
CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  identity TEXT NOT NULL,
  settings TEXT NOT NULL,
  route TEXT NOT NULL,
  overflow_count INTEGER NOT NULL DEFAULT 0,
  overflow_sequence INTEGER,
  overflow_at INTEGER,
  overflow_reason TEXT CHECK (overflow_reason IN ('backlog', 'payload_limit'))
) STRICT;
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  event_id TEXT NOT NULL,
  feed_sequence INTEGER NOT NULL REFERENCES job_events(id),
  payload TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'delivered', 'expired', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER,
  UNIQUE (subscription_id, revision, event_id)
) STRICT;
CREATE INDEX webhook_delivery_due ON webhook_deliveries(state, next_attempt_at);
CREATE INDEX webhook_delivery_subscription ON webhook_deliveries(subscription_id, id);
CREATE TABLE webhook_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  delivery_id INTEGER,
  event_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  status_code INTEGER,
  outcome TEXT NOT NULL,
  lease TEXT
) STRICT;
CREATE INDEX webhook_attempt_subscription ON webhook_attempts(subscription_id, id DESC);
`,
  },
  {
    version: 10,
    name: 'dashboard webhook ownership and test results',
    // Existing subscriptions remain file managed; no delivery, revision or private route is rewritten.
    sql: `
ALTER TABLE webhook_subscriptions ADD COLUMN source TEXT NOT NULL DEFAULT 'config' CHECK (source IN ('config', 'dashboard'));
ALTER TABLE webhook_subscriptions ADD COLUMN last_test_at INTEGER;
ALTER TABLE webhook_subscriptions ADD COLUMN last_test_outcome TEXT;
ALTER TABLE webhook_subscriptions ADD COLUMN last_test_status_code INTEGER;
`,
  },
  {
    version: 11,
    name: 'workspace launch spec compatibility barrier',
    // launch_spec may now hold a version 2 record (src/jobs/launchSpec.ts): a scratch
    // workspace, with the host id and any host default binding. Older builds read a spec
    // they do not know as NULL and would launch scratch work in a fresh worktree. This migration changes
    // no data; it only advances the schema version, so an older build's version check rejects a ledger
    // that may hold such records before it reads them. A ledger that migrated to 11 cannot go back.
    sql: 'SELECT 1;',
  },
  {
    version: 12,
    name: 'workspace root reservations',
    // launch_spec may now hold a version 3 record (a workspace decided at dispatch), which older builds would read as no
    // spec, so this migration is also the schema-version barrier for it. The new columns hold only what the dispatcher
    // resolves: workspace_kind ('root', the project's own folder, or 'worktree'; NULL for jobs without a resolved workspace)
    // and workspace_root_key (a hash of host and canonical folder, set for root jobs). workspace_root_held_at is the ledger
    // reservation: the job holds its folder from that time, and the partial unique index lets one job per host and folder
    // hold it. workspace_resume_tokens (a JSON array of opaque tokens, '[]' by default) names the follow-ups and answers the gateway has
    // begun sending to an idle root job that no outcome has settled: an attempt adds its token before it sends and removes it when T3
    // definitely did not take the message; a token that stays (an unknown outcome) keeps the folder held until the job's state takes
    // over or the grace period ends. The probe columns bound the retries of a job whose probe could not reach its host (attempts, and not before).
    // Existing rows and their indexes are unchanged.
    sql: `
ALTER TABLE jobs ADD COLUMN workspace_kind TEXT CHECK (workspace_kind IN ('root', 'worktree'));
ALTER TABLE jobs ADD COLUMN workspace_root_key TEXT;
ALTER TABLE jobs ADD COLUMN workspace_root_held_at INTEGER;
ALTER TABLE jobs ADD COLUMN workspace_resume_tokens TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN probe_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN probe_retry_at INTEGER;
CREATE INDEX jobs_workspace_root ON jobs(host_id, workspace_root_key) WHERE workspace_root_key IS NOT NULL;
CREATE UNIQUE INDEX jobs_workspace_root_held ON jobs(host_id, workspace_root_key) WHERE workspace_root_held_at IS NOT NULL;
`,
  },
  {
    version: 13,
    name: 'job pull request snapshots',
    sql: `ALTER TABLE jobs ADD COLUMN pull_requests TEXT;
ALTER TABLE jobs ADD COLUMN pull_requests_checked_at INTEGER;`,
  },
  {
    version: 14,
    name: 'external thread adoption and client opt-in scopes',
    sql: `ALTER TABLE jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'gateway' CHECK (origin IN ('gateway', 'standing', 'adopted'));
UPDATE jobs SET origin = 'standing' WHERE standing = 1;
ALTER TABLE jobs ADD COLUMN adopted_by TEXT;
ALTER TABLE jobs ADD COLUMN adopted_at INTEGER;
UPDATE jobs SET adopted_by = 'operator', adopted_at = created_at WHERE standing = 1;
CREATE INDEX jobs_host_thread ON jobs(host_id, t3_thread_id);
CREATE TABLE client_thread_scopes (
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('threads:read', 'threads:control')),
  PRIMARY KEY (client_id, scope)
) STRICT;
CREATE TABLE operator_scope_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  scope TEXT NOT NULL,
  changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER operator_scope_events_no_update BEFORE UPDATE ON operator_scope_events BEGIN SELECT RAISE(ABORT, 'scope events are append-only'); END;
CREATE TRIGGER operator_scope_events_no_delete BEFORE DELETE ON operator_scope_events BEGIN SELECT RAISE(ABORT, 'scope events are append-only'); END;
CREATE TABLE thread_action_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER thread_action_events_no_update BEFORE UPDATE ON thread_action_events BEGIN SELECT RAISE(ABORT, 'thread actions are append-only'); END;
CREATE TRIGGER thread_action_events_no_delete BEFORE DELETE ON thread_action_events BEGIN SELECT RAISE(ABORT, 'thread actions are append-only'); END;`,
  },
  {
    version: 15,
    name: 'host and project webhook targets',
    // Settings gain optional paired targets. Existing alias filters, routes, revisions and queues stay byte-for-byte intact.
    // The version barrier prevents an older sender from ignoring the new filter and broadcasting it.
    sql: 'SELECT 1;',
  },
  {
    version: 16,
    name: 'recoverable worker turn failures',
    // Reclassify the old representation, not a new worker event. Preserve errors, timestamps,
    // settlement acknowledgments and immutable outbox payloads. Older builds refuse this ledger.
    sql: `UPDATE jobs SET state = 'idle', finished_at = NULL
      WHERE state = 'failed' AND last_error_code = 't3_run_failed' AND t3_thread_id IS NOT NULL;`,
  },
  {
    version: 17,
    name: 'queued launch attachments',
    sql: `CREATE TABLE job_launch_attachments (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
) STRICT;`,
  },
  {
    version: 18,
    name: 'precise notifications health and replay',
    // Additive: preserve routes, revisions, pending bytes and attempts. Older senders must refuse
    // the new job/client/owner filters. Rollback requires a stopped pre-upgrade ledger backup.
    sql: `CREATE TABLE webhook_health (
  subscription_id TEXT PRIMARY KEY REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  dead_lettered INTEGER NOT NULL DEFAULT 0,
  archive_floor INTEGER NOT NULL DEFAULT 0,
  archive_floor_at INTEGER
) STRICT;
INSERT INTO webhook_health (subscription_id, archive_floor, archive_floor_at)
  SELECT id, COALESCE((SELECT MAX(id) FROM job_events), 0), (SELECT MAX(created_at) FROM job_events) FROM webhook_subscriptions;
CREATE TABLE webhook_archive (
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  feed_sequence INTEGER NOT NULL REFERENCES job_events(id),
  event_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, revision, feed_sequence)
) STRICT;
CREATE INDEX webhook_archive_sequence ON webhook_archive(subscription_id, feed_sequence, created_at);
CREATE INDEX webhook_archive_time ON webhook_archive(subscription_id, created_at, feed_sequence);
CREATE TABLE webhook_job_bindings (
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  events TEXT NOT NULL,
  PRIMARY KEY (subscription_id, revision, job_id)
) STRICT;`,
  },
  {
    version: 19,
    name: 'credential alerts and outbox',
    sql: `CREATE TABLE credential_alerts (
  host_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at INTEGER,
  raised_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (host_id, kind)
) STRICT;
CREATE TABLE credential_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  event_id TEXT NOT NULL,
  feed_sequence INTEGER,
  payload TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'delivered', 'expired', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER,
  UNIQUE (subscription_id, revision, event_id)
) STRICT;
CREATE INDEX credential_delivery_due ON credential_deliveries(state, next_attempt_at);
CREATE INDEX credential_delivery_subscription ON credential_deliveries(subscription_id, id);
CREATE VIEW notification_deliveries AS
  SELECT *, 'job' AS source FROM webhook_deliveries UNION ALL
  SELECT *, 'credential' AS source FROM credential_deliveries;`,
  },
  {
    version: 20,
    name: 'operator token rotation and usage',
    sql: `CREATE TABLE operator_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE REFERENCES access_tokens(token_hash) ON DELETE CASCADE,
  last_used_at INTEGER
) STRICT;
INSERT INTO operator_tokens (id, token_hash)
  SELECT lower(hex(randomblob(12))), a.token_hash FROM access_tokens a
  JOIN token_families f ON f.id = a.family_id JOIN oauth_clients c ON c.id = f.client_id
  WHERE a.refresh_token_hash = '' AND c.redirect_uris = '[]';
CREATE TABLE operator_token_calls (
  token_id TEXT NOT NULL REFERENCES operator_tokens(id) ON DELETE CASCADE,
  hour INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (token_id, hour)
) STRICT;`,
  },
  {
    version: 21,
    name: 'per-client project access',
    sql: `CREATE TABLE client_project_access (
  client_id TEXT PRIMARY KEY REFERENCES oauth_clients(id) ON DELETE CASCADE,
  projects TEXT NOT NULL
) STRICT;`,
  },
];

/**
 * The excerpt bound when migration 6 was written: 2,000 UTF-16 code units, the unit JavaScript string
 * lengths and T3's `maxCharsPerItem` count. Fixed here so the migration never changes with the code.
 */
const V6_EXCERPT_CHARS = 2000;

/**
 * Migration 6: add `latest_message_truncated`. Excerpts stored before it carry no flag, so one of
 * 1,999 or 2,000 code units (T3 may stop one short to keep a surrogate pair whole) is taken as cut:
 * a message of exactly that length is flagged too, which at worst makes an agent read it in full.
 */
function addExcerptTruncated(db: DatabaseSync): void {
  db.exec('ALTER TABLE jobs ADD COLUMN latest_message_truncated INTEGER NOT NULL DEFAULT 0;');
  const rows = db.prepare('SELECT id, latest_message_excerpt FROM jobs WHERE latest_message_excerpt IS NOT NULL').all() as {
    id: string;
    latest_message_excerpt: string;
  }[];
  const mark = db.prepare('UPDATE jobs SET latest_message_truncated = 1 WHERE id = ?');
  for (const row of rows) if (row.latest_message_excerpt.length >= V6_EXCERPT_CHARS - 1) mark.run(row.id);
}

const JOBS_V2_TABLE = `
CREATE TABLE jobs_v2 (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  project_alias TEXT NOT NULL,
  host_id TEXT NOT NULL,
  t3_project_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'dispatching', 'running', 'needs_input', 'idle',
    'cancel_requested', 'cancelled', 'failed', 'unknown', 'released'
  )),
  task TEXT NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,
  t3_thread_id TEXT,
  t3_thread_title TEXT,
  t3_thread_link TEXT,
  last_run_id TEXT,
  pending_request_ids TEXT NOT NULL DEFAULT '[]',
  latest_message_excerpt TEXT,
  latest_activity_at INTEGER,
  read_position INTEGER,
  host_unreachable_since INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_changed_at INTEGER NOT NULL,
  dispatch_started_at INTEGER,
  finished_at INTEGER,
  standing INTEGER NOT NULL DEFAULT 0 CHECK (standing IN (0, 1))
) STRICT`;

/** A T3 read position as an integer: kept if it is one, converted from digits in text, else NULL. */
const READ_POSITION_AS_INTEGER = `CASE
    WHEN typeof(read_position) = 'integer' THEN read_position
    WHEN typeof(read_position) = 'real' AND read_position = CAST(read_position AS INTEGER) THEN CAST(read_position AS INTEGER)
    WHEN typeof(read_position) = 'text' AND trim(read_position) <> '' AND trim(read_position) NOT GLOB '*[^0-9]*'
      AND length(trim(read_position)) <= 15 THEN CAST(trim(read_position) AS INTEGER)
    ELSE NULL
  END`;

/**
 * Migration 2: rebuild `jobs` with the `released` state and the `standing` column. The columns to copy
 * come from the table as it is, not as migration 1 reads today: migration 1 was corrected in place
 * before it reached main, so a database created by an earlier build may lack `state_changed_at`
 * (filled from `updated_at`) or `t3_thread_link` (left NULL), or store `read_position` as text
 * (converted to an integer, NULL when it is not one). A missing column that has no such fallback
 * and cannot be NULL stops the migration with an error naming it.
 */
function rebuildJobsV2(db: DatabaseSync): void {
  const columnsOf = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: unknown }[];
  const present = new Set(columnsOf('jobs').map((column) => column.name));
  db.exec(JOBS_V2_TABLE);
  const fallbacks: Record<string, string> = { state_changed_at: 'updated_at' };
  const names: string[] = [];
  const values: string[] = [];
  for (const column of columnsOf('jobs_v2')) {
    const fallback = fallbacks[column.name];
    let value: string | undefined;
    if (present.has(column.name)) value = column.name === 'read_position' ? READ_POSITION_AS_INTEGER : column.name;
    else if (fallback !== undefined && present.has(fallback)) value = fallback;
    else if (column.notnull === 1 && column.dflt_value === null) {
      throw new GatewayError('database_error', `Migration 2 (standing jobs): table jobs has no column ${column.name}, and it cannot be filled in.`);
    }
    // Otherwise the column takes its default (NULL, or standing = 0).
    if (value === undefined) continue;
    names.push(column.name);
    values.push(value);
  }
  db.exec(`
INSERT INTO jobs_v2 (${names.join(', ')}) SELECT ${values.join(', ')} FROM jobs ORDER BY rowid;
DROP TABLE jobs;
ALTER TABLE jobs_v2 RENAME TO jobs;
CREATE INDEX jobs_state ON jobs(state);
CREATE INDEX jobs_host_state ON jobs(host_id, state);
CREATE INDEX jobs_project_created ON jobs(project_alias, created_at DESC);
CREATE INDEX jobs_thread ON jobs(t3_thread_id);
`);
}
