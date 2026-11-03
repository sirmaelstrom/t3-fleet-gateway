import { allowsProject, expandProjectAccess, projectAccess, projectFilter, projectDenied } from '../oauth/projectAccess.ts';
import type { CredentialAlertPayload } from '../hosts/alerts.ts';
import type { GatewayConfig } from '../config.ts';
import { isThreadLink, threadLink } from '../threadId.js';
import { createHash, randomUUID } from 'node:crypto';
import { transaction, type Database } from '../db/database.ts';
import { GatewayError } from '../errors.ts';
import { displayPullRequests } from '../jobs/pullRequests.ts';
import type { Job, JobEvent } from '../jobs/store.ts';
import { permits, type Scope } from '../oauth/scopes.ts';
import type { Clock } from '../time.ts';
import { DEFAULT_WEBHOOK_EVENTS, loadRoute, usesDefaultEvents, type PreciseFilters, type SubscriptionConfig, type WebhookEventType, type WebhookRoute, type WebhooksConfig } from './config.ts';

export const RETRY_WINDOW_MS = 60 * 60_000;
export const MAX_PENDING_PER_SUBSCRIPTION = 10_000;
export const MAX_ATTEMPTS_PER_SUBSCRIPTION = 100;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SUBSCRIPTIONS = 32;
const MAX_HISTORY = 1000;
export const ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MAX_ARCHIVE_EVENTS = 10_000;
export const MAX_JOB_BINDINGS = 100;
export interface NotificationCaller { clientId: string; scopes: readonly Scope[] }
export interface ReplayInput { afterCursor?: string; since?: string; limit?: number }
export interface ReplayResult { queued: number; skipped: number; nextCursor: string; hasMore: boolean; retentionGap: boolean }
export interface WebhookHealth {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureStreak: number;
  deadLettered: number;
  pending: number;
  overflowCount: number;
  replayFloorCursor: string;
  oldestReplayAt: string | null;
}
function notFound(): never { throw new GatewayError('not_found', 'Notification connection or job was not found.'); }

export type AttemptOutcome = 'in_progress' | 'delivered' | 'http_error' | 'redirect' | 'network_error' | 'tls_error' |
  'timeout' | 'response_too_large' | 'stopped' | 'abandoned' | 'expired' | 'cancelled';
export interface AttemptResult { outcome: AttemptOutcome; statusCode: number | null }
export interface DashboardTest { eventId: string; at: number; result: AttemptResult }
export interface WebhookConnection {
  id: string;
  revision: string;
  source: 'config' | 'dashboard';
  projects: string[];
  hosts: string[];
  targets: { host: string; projectId: string }[];
  jobs: string[];
  clients: string[];
  events: WebhookEventType[];
  ownerClientId: string | null;
  lastTest: { at: string; outcome: AttemptOutcome; statusCode: number | null } | null;
}
export type WebhookConnectionErrorCode = 'not_found' | 'connection_conflict' | 'file_managed' | 'connection_limit' | 'test_failed';
/** Fixed codes only: neither callers nor logs should receive private route material in an error. */
export class WebhookConnectionError extends Error {
  readonly code: WebhookConnectionErrorCode;
  constructor(code: WebhookConnectionErrorCode) {
    super(code);
    this.name = 'WebhookConnectionError';
    this.code = code;
  }
}
export interface WebhookPayload {
  eventId: string;
  type: WebhookEventType;
  timestamp: string;
  feedSequence: number;
  feedCursor: string;
  jobId: string;
  projectAlias: string;
  host: string;
  projectId: string | null;
  title: string;
  state: string;
  previousState: string | null;
  threadId: string | null;
  link: string | null;
  standing: boolean;
  waitingOnDelegatedWork: boolean;
  turnInitiator: { kind: 'gateway' | 'unknown'; clientId: string | null };
  /** At most MAX_PULL_REQUESTS of the PRs the job follows (`displayPullRequests`), so ordinary links keep the payload inside MAX_PAYLOAD_BYTES. */
  pullRequests?: { number: number; state: 'open' | 'closed' | 'merged' | null; url: string }[];
  excerpt?: string | null;
  excerptTruncated?: boolean;
}
type SubscriptionSettings = Pick<SubscriptionConfig, 'events' | 'projects' | 'hosts' | 'targets' | 'excerptChars' | 'jobs' | 'clients' | 'ownerClientId'>;
interface SubscriptionRow {
  id: string; revision: string; identity: string; settings: string; route: string; source: WebhookConnection['source'];
  last_test_at: number | null; last_test_outcome: AttemptOutcome | null; last_test_status_code: number | null;
}
interface DeliveryRow {
  id: number; subscription_id: string; revision: string; event_id: string; payload: string;
  created_at: number; expires_at: number; attempt_count: number; lease: string; lease_until: number;
}
export interface ClaimedDelivery {
  source?: 'job' | 'credential';
  id: number; subscriptionId: string; eventId: string; revision: string; payload: string;
  lease: string; attempt: number; expiresAt: number; route: WebhookRoute;
}
function eventType(event: JobEvent): WebhookEventType | undefined {
  if ((event.type === 'state_changed' || event.type === 'turn_finished') && event.detail?.reason === 'run_failed') return 'failed';
  if (event.type === 'pull_request_opened' || event.type === 'pull_request_merged') return event.type;
  if (event.type === 'delegated_work_ended') return 'delegated_work_ended';
  if (event.type === 'turn_finished') return 'idle';
  if (event.type === 'state_changed' && ['idle', 'needs_input', 'failed', 'cancelled', 'running'].includes(event.toState ?? '')) {
    return event.toState as WebhookEventType;
  }
  return undefined;
}
function excerpt(text: string | null, max: number): string | null {
  if (text === null) return null;
  let end = Math.min(text.length, max);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end);
}
function connection(row: SubscriptionRow): WebhookConnection {
  const settings = JSON.parse(row.settings) as SubscriptionSettings;
  return {
    id: row.id, revision: row.revision, source: row.source, projects: settings.projects ?? [], hosts: settings.hosts ?? [], targets: settings.targets ?? [],
    jobs: settings.jobs ?? [], clients: settings.clients ?? [], events: settings.events, ownerClientId: settings.ownerClientId ?? null,
    lastTest: row.last_test_at === null || row.last_test_outcome === null ? null
      : { at: new Date(row.last_test_at).toISOString(), outcome: row.last_test_outcome, statusCode: row.last_test_status_code },
  };
}
function identityFor(settings: SubscriptionSettings, route: WebhookRoute): string {
  return createHash('sha256').update(JSON.stringify({ settings, route })).digest('hex');
}

/** Owns private routes, immutable pending payloads, leases and code-only delivery diagnostics. */
export class WebhookStore {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #projects: GatewayConfig['projects'];
  constructor(db: Database, clock: Clock, projects: GatewayConfig['projects'] = []) {
    this.#db = db; this.#clock = clock; this.#projects = projects;
  }

  #access(clientId: string) { return expandProjectAccess(projectAccess(this.#db, clientId), { projects: this.#projects }); }

  /** Only the serving gateway applies config. Opening CLI services must never call this. */
  reconcile(config: WebhooksConfig, dataDir: string): void {
    // Read and validate every enabled secret before changing anything. A missing secret fails closed.
    const enabled = config.subscriptions.filter((s) => s.enabled).map((requested) => {
      const previous = this.#row(requested.id);
      const settings = usesDefaultEvents(requested) && previous?.source === 'config'
        ? { ...requested, events: (JSON.parse(previous.settings) as SubscriptionSettings).events } : requested;
      const route = loadRoute(settings, dataDir);
      const identity = identityFor(settings, route);
      return { settings, route, identity };
    });
    transaction(this.#db, () => {
      const old = this.#db.prepare('SELECT * FROM webhook_subscriptions').all() as unknown as SubscriptionRow[];
      const dashboard = old.filter((row) => row.source === 'dashboard');
      // Disabled entries reserve their IDs too: a file must never silently take ownership of a UI connection.
      if (dashboard.some((row) => config.subscriptions.some((s) => s.id === row.id))) {
        throw new GatewayError('config_invalid', 'Webhook subscription ID is already managed by the dashboard.');
      }
      if (dashboard.length + enabled.length > MAX_SUBSCRIPTIONS) {
        throw new GatewayError('config_invalid', 'Webhook subscription limit exceeded.');
      }
      for (const row of old.filter((row) => row.source === 'config')) {
        if (enabled.some((s) => s.settings.id === row.id && s.identity === row.identity)) continue;
        this.#cancel(row.id);
        this.#db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(row.id);
      }
      for (const { settings, route, identity } of enabled) {
        this.#db.prepare('INSERT OR IGNORE INTO webhook_subscriptions (id, revision, identity, settings, route) VALUES (?, ?, ?, ?, ?)')
          .run(settings.id, randomUUID(), identity, JSON.stringify(settings), JSON.stringify(route));
      }
      this.#prune();
    });
  }

  /** Bounded, credential-free rows for the private dashboard and offline CLI. */
  listConnections(): WebhookConnection[] {
    const rows = this.#db.prepare('SELECT * FROM webhook_subscriptions ORDER BY id LIMIT ?').all(MAX_SUBSCRIPTIONS) as unknown as SubscriptionRow[];
    return rows.map(connection);
  }

  /** Private transport input; never serialize this value into a response or log. */
  route(id: string, expectedRevision: string): WebhookRoute {
    return JSON.parse(this.#current(id, expectedRevision).route) as WebhookRoute;
  }

  dashboardRoute(id: string, expectedRevision: string): WebhookRoute {
    return JSON.parse(this.#dashboard(id, expectedRevision).route) as WebhookRoute;
  }

  /** Call only after the synthetic ping finishes; no network operation belongs inside these transactions. */
  connectDashboard(id: string, project: string, host: string, route: WebhookRoute, test: DashboardTest, projectId?: string, filters: PreciseFilters = {}): WebhookConnection {
    return transaction(this.#db, () => {
      const existing = this.#db.prepare('SELECT source FROM webhook_subscriptions WHERE id = ?').get(id);
      if (existing) throw new WebhookConnectionError(existing.source === 'config' ? 'file_managed' : 'connection_conflict');
      const count = this.#db.prepare('SELECT COUNT(*) AS n FROM webhook_subscriptions').get() as { n: number };
      if (count.n >= MAX_SUBSCRIPTIONS) throw new WebhookConnectionError('connection_limit');
      this.#requireSuccessfulTest(test);
      const settings: SubscriptionSettings = {
        ...(projectId ? { targets: [{ host, projectId }] } : { projects: [project], hosts: [host] }),
        ...filters, events: filters.events ?? [...DEFAULT_WEBHOOK_EVENTS], excerptChars: 0,
      };
      this.#db.prepare(`INSERT INTO webhook_subscriptions (id, revision, identity, settings, route, source)
        VALUES (?, ?, ?, ?, ?, 'dashboard')`)
        .run(id, randomUUID(), identityFor(settings, route), JSON.stringify(settings), JSON.stringify(route));
      this.#recordTest(id, test);
      return connection(this.#row(id)!);
    });
  }

  replaceDashboard(id: string, expectedRevision: string, route: WebhookRoute, test: DashboardTest, events?: WebhookEventType[]): WebhookConnection {
    return transaction(this.#db, () => {
      const row = this.#dashboard(id, expectedRevision);
      this.#requireSuccessfulTest(test);
      const settings = JSON.parse(row.settings) as SubscriptionSettings;
      if (events) settings.events = events;
      this.#cancel(id);
      this.#db.prepare(`UPDATE webhook_subscriptions SET revision = ?, identity = ?, route = ?, settings = ?,
        overflow_count = 0, overflow_sequence = NULL, overflow_at = NULL, overflow_reason = NULL,
        last_test_at = NULL, last_test_outcome = NULL, last_test_status_code = NULL WHERE id = ?`)
        .run(randomUUID(), identityFor(settings, route), JSON.stringify(route), JSON.stringify(settings), id);
      this.#recordTest(id, test);
      return connection(this.#row(id)!);
    });
  }

  disconnectDashboard(id: string, expectedRevision: string): void {
    transaction(this.#db, () => {
      this.#dashboard(id, expectedRevision);
      this.#cancel(id);
      this.#db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id);
      this.#prune();
    });
  }

  /** A test of a saved route changes only safe diagnostics, never its revision or queued deliveries. */
  testConnection(id: string, expectedRevision: string, test: DashboardTest): WebhookConnection {
    return transaction(this.#db, () => {
      this.#current(id, expectedRevision);
      this.#recordTest(id, test);
      return connection(this.#row(id)!);
    });
  }

  /** Called synchronously inside the JobStore event transaction, with the event-time job snapshot. */
  #projectAllowed(settings: SubscriptionSettings, host: string, alias: string | null, projectId: string | null, jobClient?: string): boolean {
    const clients = settings.ownerClientId ? [settings.ownerClientId] :
      jobClient && settings.clients?.includes(jobClient) ? [jobClient] : [];
    return clients.every((id) => allowsProject(this.#access(id), host, alias, projectId));
  }

  /** Reauthorize captured payloads at replay, claim and immediately before sending. */
  #payloadAllowed(settings: SubscriptionSettings, payloadText: string, subscription: { id: string; revision: string }): boolean {
    const recipients = settings.ownerClientId ? [settings.ownerClientId] : settings.clients ?? [];
    if (recipients.every((id) => this.#access(id) === undefined)) return true;
    const payload = JSON.parse(payloadText) as { host: string; jobId?: string; type: string };
    if (payload.jobId) {
      const job = this.#db.prepare('SELECT host_id, project_alias, t3_project_id, client_id FROM jobs WHERE id = ?').get(payload.jobId);
      return !!job && this.#projectAllowed(settings, String(job.host_id), String(job.project_alias),
        job.t3_project_id as string | null, String(job.client_id));
    }
    // Credential notices need one affected job satisfying this connection's filters and current bot policy.
    const audience = recipients.map((id) => ({ id, filter: projectFilter(this.#access(id), 'j') }));
    const audienceSql = audience.map(({ filter }) => `(j.client_id = ? AND (${filter.sql}))`).join(' OR ');
    return !!this.#db.prepare(`SELECT 1 FROM jobs j WHERE j.host_id = ? AND (${audienceSql})
      AND (? IS NULL OR j.client_id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR j.project_alias IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR j.id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(?) t WHERE json_extract(t.value, '$.host') = j.host_id
        AND json_extract(t.value, '$.projectId') = j.t3_project_id))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM webhook_job_bindings b
        WHERE b.subscription_id = ? AND b.revision = ? AND b.job_id = j.id
        AND ? IN (SELECT value FROM json_each(b.events)))) LIMIT 1`)
      .get(payload.host, ...audience.flatMap(({ id, filter }) => [id, ...filter.params]),
        settings.clients ? 1 : null, JSON.stringify(settings.clients ?? []),
        settings.projects ? 1 : null, JSON.stringify(settings.projects ?? []),
        settings.jobs ? 1 : null, JSON.stringify(settings.jobs ?? []), settings.targets ? 1 : null, JSON.stringify(settings.targets ?? []),
        settings.ownerClientId ?? null, subscription.id, subscription.revision, payload.type);
  }

  capture(event: JobEvent, job: Job, turnRunId: string | null = job.lastRunId): void {
    const type = eventType(event);
    if (!type) return;
    const rows = this.#db.prepare('SELECT * FROM webhook_subscriptions').all() as unknown as SubscriptionRow[];
    const matches = rows.filter((row) => {
      const s = JSON.parse(row.settings) as SubscriptionSettings;
      return this.#projectAllowed(s, job.hostId, job.projectAlias, job.t3ProjectId, job.clientId) && (!s.targets || s.targets.some((t) => t.host === job.hostId && t.projectId === job.t3ProjectId)) &&
        s.events.includes(type) && (!s.projects || s.projects.includes(job.projectAlias)) && (!s.hosts || s.hosts.includes(job.hostId)) &&
        (!s.jobs || s.jobs.includes(job.id)) && (!s.clients || s.clients.includes(job.clientId)) &&
        (!s.ownerClientId || (s.ownerClientId === job.clientId && this.#bindingMatches(row, job.id, type)));
    });
    if (!matches.length) return;
    const turn = turnRunId === null ? undefined : this.#db.prepare('SELECT client_id FROM job_turns WHERE job_id = ? AND run_id = ?')
      .get(job.id, turnRunId) as { client_id: string } | undefined;
    const payload: WebhookPayload = {
      eventId: randomUUID(), type, timestamp: new Date(event.createdAt).toISOString(), feedSequence: event.id, feedCursor: String(event.id),
      jobId: job.id, projectAlias: job.projectAlias, host: job.hostId, projectId: job.t3ProjectId, title: job.title,
      state: job.state, previousState: event.fromState, threadId: job.threadId,
      // Keep T3's environment when available; never expose a legacy HTTP URL with potentially sensitive query parameters.
      link: isThreadLink(job.threadLink) ? job.threadLink : threadLink(job.threadId),
      standing: job.standing, waitingOnDelegatedWork: job.delegatedWork.length > 0 || job.delegatedUntracked > 0,
      turnInitiator: turn ? { kind: 'gateway', clientId: turn.client_id } : { kind: 'unknown', clientId: null },
    };
    if (type === 'pull_request_opened' || type === 'pull_request_merged') {
      payload.pullRequests = displayPullRequests(job.pullRequests ?? []).map(({ number, state, url }) => ({ number, state, url }));
    }
    for (const row of matches) {
      const s = JSON.parse(row.settings) as SubscriptionSettings;
      const body = { ...payload };
      if (s.excerptChars > 0) {
        body.excerpt = excerpt(job.latestMessageExcerpt, s.excerptChars);
        body.excerptTruncated = job.latestMessageTruncated || (body.excerpt?.length ?? 0) < (job.latestMessageExcerpt?.length ?? 0);
      }
      const json = JSON.stringify(body);
      this.#ensureHealth(row.id, event.id - 1);
      if (Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES) {
        this.#db.prepare(`INSERT INTO webhook_archive (subscription_id, revision, feed_sequence, event_id, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(row.id, row.revision, event.id, body.eventId, json, event.createdAt);
        this.#pruneArchive(row.id);
      }
      const pending = this.#db.prepare("SELECT COUNT(*) AS n FROM notification_deliveries WHERE subscription_id = ? AND state IN ('pending', 'sending')")
        .get(row.id) as { n: number };
      const overflow = Buffer.byteLength(json) > MAX_PAYLOAD_BYTES ? 'payload_limit'
        : pending.n >= MAX_PENDING_PER_SUBSCRIPTION ? 'backlog' : null;
      if (overflow !== null) {
        // Never evict committed active deliveries, truncate opaque IDs, or block a job transition.
        this.#db.prepare(`UPDATE webhook_subscriptions SET overflow_count = overflow_count + 1,
          overflow_sequence = ?, overflow_at = ?, overflow_reason = ? WHERE id = ?`).run(event.id, event.createdAt, overflow, row.id);
        continue;
      }
      this.#db.prepare(`INSERT INTO webhook_deliveries
        (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(row.id, row.revision, payload.eventId, event.id, json, event.createdAt, event.createdAt + RETRY_WINDOW_MS, event.createdAt);
    }
  }

  /** Called inside CredentialAlerts' transaction. Host alerts have no job attribution or job-feed cursor. */
  captureCredential(payload: CredentialAlertPayload, projects: GatewayConfig['projects']): void {
    const now = this.#clock();
    const rows = this.#db.prepare('SELECT * FROM webhook_subscriptions').all() as unknown as SubscriptionRow[];
    for (const row of rows) {
      const s = JSON.parse(row.settings) as SubscriptionSettings;
      if (!this.#payloadAllowed(s, JSON.stringify(payload), row)) continue;
      if (!s.events.includes(payload.type) || (s.hosts && !s.hosts.includes(payload.host))) continue;
      // Intersect every route filter. Precise bot/job filters need a single affected ledger job
      // satisfying the entire intersection, rather than borrowing identity from another job.
      if (s.projects || s.targets || s.jobs || s.clients || s.ownerClientId) {
        const configuredMatch = !s.jobs && !s.clients && !s.ownerClientId && projects.some((p) => p.host === payload.host &&
          (!s.projects || s.projects.includes(p.alias)) && (!s.targets || s.targets.some((t) => t.host === p.host && t.projectId === p.t3ProjectId)));
        const matches = this.#db.prepare(`SELECT 1 FROM jobs j WHERE j.host_id = ?
          AND (? IS NULL OR j.client_id = ?)
          AND (? IS NULL OR j.id IN (SELECT value FROM json_each(?)))
          AND (? IS NULL OR j.client_id IN (SELECT value FROM json_each(?)))
          AND (? IS NULL OR j.project_alias IN (SELECT value FROM json_each(?)))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(?) t
            WHERE json_extract(t.value, '$.host') = j.host_id AND json_extract(t.value, '$.projectId') = j.t3_project_id))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM webhook_job_bindings b WHERE b.subscription_id = ? AND b.revision = ?
            AND b.job_id = j.id AND ? IN (SELECT value FROM json_each(b.events)))) LIMIT 1`)
          .get(payload.host, s.ownerClientId ?? null, s.ownerClientId ?? null,
            s.jobs ? 1 : null, JSON.stringify(s.jobs ?? []), s.clients ? 1 : null, JSON.stringify(s.clients ?? []),
            s.projects ? 1 : null, JSON.stringify(s.projects ?? []), s.targets ? 1 : null, JSON.stringify(s.targets ?? []),
            s.ownerClientId ?? null, row.id, row.revision, payload.type);
        if (!configuredMatch && !matches) continue;
      }
      this.#ensureHealth(row.id);
      const pending = Number(this.#db.prepare(`SELECT COUNT(*) AS n FROM notification_deliveries
        WHERE subscription_id = ? AND state IN ('pending', 'sending')`).get(row.id)!.n);
      if (pending >= MAX_PENDING_PER_SUBSCRIPTION) {
        this.#db.prepare(`UPDATE webhook_subscriptions SET overflow_count = overflow_count + 1,
          overflow_at = ?, overflow_reason = 'backlog' WHERE id = ?`).run(now, row.id);
        continue;
      }
      this.#db.prepare(`INSERT INTO credential_deliveries
        (subscription_id, revision, event_id, payload, created_at, expires_at, next_attempt_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(row.id, row.revision, payload.eventId, JSON.stringify(payload), now, now + RETRY_WINDOW_MS, now);
    }
  }

  claim(limit: number, leaseMs: number): ClaimedDelivery[] {
    return transaction(this.#db, () => {
      const now = this.#clock();
      for (const table of ['webhook_deliveries', 'credential_deliveries']) {
        const abandoned = this.#db.prepare(`SELECT subscription_id FROM ${table} WHERE state = 'sending' AND lease_until <= ?`).all(now);
        for (const row of abandoned) this.#failure(String(row.subscription_id), now);
        this.#db.prepare(`UPDATE webhook_attempts SET outcome = 'abandoned', lease = NULL WHERE outcome = 'in_progress' AND lease IN
          (SELECT lease FROM ${table} WHERE state = 'sending' AND lease_until <= ?)`).run(now);
        this.#db.prepare(`UPDATE ${table} SET state = 'pending', lease = NULL, lease_until = NULL WHERE state = 'sending' AND lease_until <= ?`).run(now);
        const expired = this.#db.prepare(`SELECT subscription_id, COUNT(*) AS n FROM ${table} WHERE state = 'pending' AND expires_at <= ? GROUP BY subscription_id`).all(now);
        for (const row of expired) this.#deadLetters(String(row.subscription_id), Number(row.n));
        this.#db.prepare(`UPDATE ${table} SET state = 'expired', payload = NULL WHERE state = 'pending' AND expires_at <= ?`).run(now);
      }
      // One in-flight request per subscription, enforced across DB connections. A failed receiver
      // cannot occupy all sender slots while other subscriptions have work ready.
      const next = this.#db.prepare(`SELECT d.*, s.route, s.settings FROM notification_deliveries d JOIN webhook_subscriptions s
        ON s.id = d.subscription_id AND s.revision = d.revision
        WHERE d.state = 'pending' AND d.next_attempt_at <= ? AND NOT EXISTS
          (SELECT 1 FROM notification_deliveries busy WHERE busy.subscription_id = d.subscription_id AND busy.state = 'sending')
        ORDER BY d.next_attempt_at, d.id LIMIT 1`);
      const claims: ClaimedDelivery[] = [];
      for (let n = 0; n < limit; n++) {
        const row = next.get(now) as (DeliveryRow & { route: string; settings: string; source: 'job' | 'credential' }) | undefined;
        if (!row) break;
        if (!this.#payloadAllowed(JSON.parse(row.settings) as SubscriptionSettings, row.payload, { id: row.subscription_id, revision: row.revision })) {
          this.#db.prepare(`UPDATE ${row.source === 'credential' ? 'credential_deliveries' : 'webhook_deliveries'}
            SET state = 'cancelled', payload = NULL WHERE id = ?`).run(row.id);
          continue;
        }
        const lease = randomUUID();
        this.#db.prepare(`UPDATE ${row.source === 'credential' ? 'credential_deliveries' : 'webhook_deliveries'} SET state = 'sending', lease = ?, lease_until = ?, attempt_count = attempt_count + 1 WHERE id = ?`)
          .run(lease, now + leaseMs, row.id);
        this.#db.prepare(`INSERT INTO webhook_attempts (subscription_id, delivery_id, event_id, attempted_at, outcome, lease)
          VALUES (?, ?, ?, ?, 'in_progress', ?)`).run(row.subscription_id, row.source === 'credential' ? null : row.id, row.event_id, now, lease);
        claims.push({ source: row.source, id: row.id, subscriptionId: row.subscription_id, revision: row.revision, eventId: row.event_id, payload: row.payload,
          lease, attempt: row.attempt_count + 1, expiresAt: row.expires_at, route: JSON.parse(row.route) as WebhookRoute });
      }
      for (const row of this.#db.prepare('SELECT id FROM webhook_subscriptions').all()) this.#pruneArchive(String(row.id));
      this.#prune();
      return claims;
    });
  }

  active(claim: ClaimedDelivery): boolean {
    const row = this.#db.prepare(`SELECT s.id, s.revision, s.settings, d.payload FROM notification_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id AND s.revision = d.revision
      WHERE d.id = ? AND d.lease = ? AND d.state = 'sending' AND d.source = ?`).get(claim.id, claim.lease, claim.source ?? 'job');
    return !!row && this.#payloadAllowed(JSON.parse(String(row.settings)) as SubscriptionSettings, String(row.payload), { id: String(row.id), revision: String(row.revision) });
  }

  finish(claim: ClaimedDelivery, result: AttemptResult): void {
    transaction(this.#db, () => {
      if (!this.active(claim)) return;
      const now = this.#clock();
      const state = result.outcome === 'delivered' ? 'delivered' : now >= claim.expiresAt ? 'expired' : 'pending';
      if (result.outcome === 'delivered') {
        this.#ensureHealth(claim.subscriptionId);
        this.#db.prepare('UPDATE webhook_health SET last_success_at = ?, failure_streak = 0 WHERE subscription_id = ?').run(now, claim.subscriptionId);
      } else if (result.outcome !== 'stopped') this.#failure(claim.subscriptionId, now);
      if (state === 'expired') this.#deadLetters(claim.subscriptionId, 1);
      const delay = result.outcome === 'stopped' ? 0 : Math.min(300_000, 5000 * 2 ** Math.min(claim.attempt - 1, 10));
      this.#db.prepare('UPDATE webhook_attempts SET status_code = ?, outcome = ?, lease = NULL WHERE lease = ?')
        .run(result.statusCode, result.outcome, claim.lease);
      this.#db.prepare(`UPDATE ${claim.source === 'credential' ? 'credential_deliveries' : 'webhook_deliveries'} SET state = ?, next_attempt_at = ?, lease = NULL, lease_until = NULL,
        payload = CASE WHEN ? = 'pending' THEN payload ELSE NULL END WHERE id = ? AND lease = ?`)
        .run(state, Math.min(now + delay, claim.expiresAt), state, claim.id, claim.lease);
      this.#prune();
    });
  }

  recordPing(subscriptionId: string, eventId: string, at: number, result: AttemptResult): void {
    transaction(this.#db, () => {
      this.#db.prepare('INSERT INTO webhook_attempts (subscription_id, event_id, attempted_at, status_code, outcome) VALUES (?, ?, ?, ?, ?)')
        .run(subscriptionId, eventId, at, result.statusCode, result.outcome);
      this.#prune();
    });
  }

  diagnostics(id?: string, limit = 20) {
    const bounded = Math.max(1, Math.min(MAX_ATTEMPTS_PER_SUBSCRIPTION, Math.trunc(limit) || 20));
    const subscriptions = this.#db.prepare(`SELECT id, source, overflow_count, overflow_sequence, overflow_at, overflow_reason FROM webhook_subscriptions
      ${id === undefined ? '' : 'WHERE id = ?'} ORDER BY id`).all(...(id === undefined ? [] : [id]));
    const deliveries = this.#db.prepare(`SELECT subscription_id, state, COUNT(*) AS count FROM notification_deliveries
      ${id === undefined ? '' : 'WHERE subscription_id = ?'} GROUP BY subscription_id, state ORDER BY subscription_id, state`)
      .all(...(id === undefined ? [] : [id]));
    const attempts = this.#db.prepare(`SELECT subscription_id, event_id, attempted_at, status_code, outcome FROM webhook_attempts
      ${id === undefined ? '' : 'WHERE subscription_id = ?'} ORDER BY id DESC LIMIT ?`).all(...(id === undefined ? [] : [id]), bounded);
    return { subscriptions, deliveries, attempts, health: this.health(id) };
  }

  /** Safe aggregate delivery state; pings do not mask a failing delivery stream. */
  health(id?: string): { id: string; health: WebhookHealth }[] {
    return this.listConnections().filter((row) => id === undefined || row.id === id).map((row) => {
      const h = this.#db.prepare(`SELECT h.*, s.overflow_count,
        (SELECT COUNT(*) FROM notification_deliveries d WHERE d.subscription_id = s.id AND d.state IN ('pending', 'sending')) AS pending,
        (SELECT MIN(created_at) FROM webhook_archive a WHERE a.subscription_id = s.id AND a.created_at > ?) AS oldest
        FROM webhook_subscriptions s LEFT JOIN webhook_health h ON h.subscription_id = s.id WHERE s.id = ?`)
        .get(this.#clock() - ARCHIVE_RETENTION_MS, row.id)!;
      const iso = (value: unknown) => typeof value === 'number' ? new Date(value).toISOString() : null;
      return { id: row.id, health: { lastSuccessAt: iso(h.last_success_at), lastFailureAt: iso(h.last_failure_at),
        failureStreak: Number(h.failure_streak ?? 0), deadLettered: Number(h.dead_lettered ?? 0), pending: Number(h.pending),
        overflowCount: Number(h.overflow_count), replayFloorCursor: String(h.archive_floor ?? 0), oldestReplayAt: iso(h.oldest) } };
    });
  }

  /** Destination authority comes from operator config; OAuth grants gate each management call. */
  ownedConnections(caller: NotificationCaller) {
    return this.listConnections().filter((row) => row.ownerClientId === caller.clientId && row.hosts.length > 0 &&
      row.hosts.every((host) => permits(caller.scopes, 'read', host))).map((row) => ({ ...row,
      projects: row.projects.filter((alias) => row.hosts.some((host) => allowsProject(this.#access(caller.clientId), host, alias))),
      targets: row.targets.filter((t) => allowsProject(this.#access(caller.clientId), t.host, null, t.projectId)),
      jobs: row.jobs.filter((id) => this.#allowedJob(caller.clientId, id)),
      healthAvailable: this.#access(caller.clientId) === undefined,
      health: this.#access(caller.clientId) === undefined ? this.health(row.id)[0]!.health :
        { lastSuccessAt: null, lastFailureAt: null, failureStreak: 0, deadLettered: 0, pending: 0, overflowCount: 0, replayFloorCursor: '0', oldestReplayAt: null },
      subscriptions: this.#db.prepare('SELECT job_id AS jobId, events FROM webhook_job_bindings WHERE subscription_id = ? AND revision = ? ORDER BY job_id LIMIT ?')
        .all(row.id, row.revision, MAX_JOB_BINDINGS).filter((b) => this.#allowedJob(caller.clientId, String(b.jobId))).map((b) => ({ jobId: String(b.jobId), events: JSON.parse(String(b.events)) as WebhookEventType[] })),
    }));
  }

  subscribe(caller: NotificationCaller, id: string, jobId: string, events?: WebhookEventType[], remove = false): void {
    transaction(this.#db, () => {
      const row = this.#owned(caller, id);
      const settings = JSON.parse(row.settings) as SubscriptionSettings;
      // Authorize in SQL, before parsing a stored job or revealing any other client's job.
      const hosts = settings.hosts!;
      const job = this.#db.prepare(`SELECT id, project_alias, t3_project_id, host_id FROM jobs WHERE id = ? AND client_id = ?
        AND origin = 'gateway' AND host_id IN (${hosts.map(() => '?').join(',')})`).get(jobId, caller.clientId, ...hosts);
      if (job && !this.#allowedJob(caller.clientId, jobId)) projectDenied();
      if (!job || (settings.jobs && !settings.jobs.includes(jobId)) || (settings.clients && !settings.clients.includes(caller.clientId)) ||
        (settings.projects && !settings.projects.includes(String(job.project_alias))) ||
        (settings.targets && !settings.targets.some((t) => t.host === job.host_id && t.projectId === job.t3_project_id))) notFound();
      if (remove) {
        this.#db.prepare('DELETE FROM webhook_job_bindings WHERE subscription_id = ? AND revision = ? AND job_id = ?').run(id, row.revision, jobId);
        return;
      }
      const chosen = [...new Set(events ?? settings.events)];
      if (!chosen.length || chosen.some((event) => !settings.events.includes(event))) {
        throw new GatewayError('invalid_argument', 'Choose events permitted by the notification connection.');
      }
      const existing = this.#db.prepare('SELECT 1 FROM webhook_job_bindings WHERE subscription_id = ? AND revision = ? AND job_id = ?').get(id, row.revision, jobId);
      const count = this.#db.prepare('SELECT COUNT(*) AS n FROM webhook_job_bindings WHERE subscription_id = ?').get(id)!;
      if (!existing && Number(count.n) >= MAX_JOB_BINDINGS) throw new GatewayError('invalid_argument', 'Notification job subscription limit reached.');
      this.#db.prepare(`INSERT INTO webhook_job_bindings (subscription_id, revision, job_id, events) VALUES (?, ?, ?, ?)
        ON CONFLICT(subscription_id, revision, job_id) DO UPDATE SET events = excluded.events`).run(id, row.revision, jobId, JSON.stringify(chosen));
    });
  }

  replayOwned(caller: NotificationCaller, id: string, input: ReplayInput): ReplayResult {
    // The ownership and host ceiling are checked again in the same write transaction as replay.
    return transaction(this.#db, () => this.#replay(this.#owned(caller, id), input));
  }

  /** Operator-only local CLI path; does not apply configuration or read a receiver credential. */
  replay(id: string, input: ReplayInput): ReplayResult {
    return transaction(this.#db, () => {
      const row = this.#row(id);
      if (!row) notFound();
      return this.#replay(row, input);
    });
  }

  #replay(row: SubscriptionRow, input: ReplayInput): ReplayResult {
    if ((input.afterCursor === undefined) === (input.since === undefined) ||
      (input.afterCursor !== undefined && (!/^\d{1,16}$/.test(input.afterCursor) || !Number.isSafeInteger(Number(input.afterCursor)))) ||
      (input.since !== undefined && !Number.isFinite(Date.parse(input.since))) ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200))) {
      throw new GatewayError('invalid_argument', 'Replay needs exactly one afterCursor or ISO time since, and a limit from 1 to 200.');
    }
    this.#ensureHealth(row.id);
    this.#pruneArchive(row.id);
    const h = this.#db.prepare('SELECT archive_floor, archive_floor_at FROM webhook_health WHERE subscription_id = ?').get(row.id)!;
    const cursor = Number(input.afterCursor ?? 0);
    const since = input.since === undefined ? null : Date.parse(input.since);
    const limit = input.limit ?? 200;
    const settings = JSON.parse(row.settings) as SubscriptionSettings;
    const access = settings.ownerClientId ? this.#access(settings.ownerClientId) : undefined;
    const filter = projectFilter(access, 'j');
    const events = this.#db.prepare(`SELECT * FROM webhook_archive WHERE subscription_id = ? AND revision = ? AND feed_sequence > ?
      AND (? IS NULL OR created_at >= ?) AND ${access === undefined ? '1' : `EXISTS (SELECT 1 FROM jobs j
        WHERE j.id = json_extract(webhook_archive.payload, '$.jobId') AND (${filter.sql}))`}
      ORDER BY feed_sequence LIMIT ?`).all(row.id, row.revision, cursor, since, since, ...filter.params, limit + 1);
    const page = events.slice(0, limit);
    let queued = 0;
    let skipped = 0;
    let nextCursor = input.afterCursor ?? String(events[0] ? Number(events[0].feed_sequence) - 1 : h.archive_floor);
    const now = this.#clock();
    let pending = Number(this.#db.prepare("SELECT COUNT(*) AS n FROM notification_deliveries WHERE subscription_id = ? AND state IN ('pending', 'sending')").get(row.id)!.n);
    let blocked = false;
    for (const event of page) {
      if (!this.#payloadAllowed(settings, String(event.payload), row)) { skipped++; nextCursor = String(event.feed_sequence); continue; }
      const existing = this.#db.prepare('SELECT state FROM webhook_deliveries WHERE subscription_id = ? AND revision = ? AND event_id = ?')
        .get(row.id, row.revision, event.event_id!);
      if (existing?.state === 'pending' || existing?.state === 'sending') { skipped++; nextCursor = String(event.feed_sequence); continue; }
      if (pending >= MAX_PENDING_PER_SUBSCRIPTION) { blocked = true; break; }
      this.#db.prepare(`INSERT INTO webhook_deliveries
        (subscription_id, revision, event_id, feed_sequence, payload, created_at, expires_at, next_attempt_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(subscription_id, revision, event_id) DO UPDATE SET
        payload = excluded.payload, expires_at = excluded.expires_at, next_attempt_at = excluded.next_attempt_at,
        state = 'pending', attempt_count = 0, lease = NULL, lease_until = NULL`)
        .run(row.id, row.revision, event.event_id!, event.feed_sequence!, event.payload!, event.created_at!, now + RETRY_WINDOW_MS, now);
      queued++; pending++; nextCursor = String(event.feed_sequence);
    }
    return { queued, skipped, nextCursor, hasMore: blocked || events.length > limit,
      retentionGap: since === null ? cursor < Number(h.archive_floor) :
        since < now - ARCHIVE_RETENTION_MS || (typeof h.archive_floor_at === 'number' && since <= h.archive_floor_at) };
  }

  #allowedJob(clientId: string, jobId: string): boolean {
    const filter = projectFilter(this.#access(clientId));
    return !!this.#db.prepare(`SELECT 1 FROM jobs WHERE id = ? AND (${filter.sql})`).get(jobId, ...filter.params);
  }

  #owned(caller: NotificationCaller, id: string): SubscriptionRow {
    const row = this.#row(id);
    if (!row) notFound();
    const settings = JSON.parse(row.settings) as SubscriptionSettings;
    if (settings.ownerClientId !== caller.clientId || !settings.hosts?.length ||
      !settings.hosts.every((host) => permits(caller.scopes, 'operate', host))) notFound();
    return row;
  }

  #bindingMatches(row: SubscriptionRow, jobId: string, type: WebhookEventType): boolean {
    const binding = this.#db.prepare('SELECT events FROM webhook_job_bindings WHERE subscription_id = ? AND revision = ? AND job_id = ?')
      .get(row.id, row.revision, jobId);
    return !!binding && (JSON.parse(String(binding.events)) as WebhookEventType[]).includes(type);
  }

  #ensureHealth(id: string, floor?: number): void {
    this.#db.prepare(`INSERT OR IGNORE INTO webhook_health (subscription_id, archive_floor, archive_floor_at)
      SELECT id, ?, ? FROM webhook_subscriptions WHERE id = ?`)
      .run(floor ?? Number(this.#db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM job_events').get()!.n), this.#clock(), id);
  }

  #failure(id: string, at: number): void {
    this.#ensureHealth(id);
    this.#db.prepare('UPDATE webhook_health SET last_failure_at = ?, failure_streak = failure_streak + 1 WHERE subscription_id = ?').run(at, id);
  }

  #deadLetters(id: string, count: number): void {
    this.#ensureHealth(id);
    this.#db.prepare('UPDATE webhook_health SET dead_lettered = dead_lettered + ? WHERE subscription_id = ?').run(count, id);
  }

  #pruneArchive(id: string): void {
    // Indexed by connection/revision/sequence. Keep original content bounded even after queue completion.
    const cutoff = this.#clock() - ARCHIVE_RETENTION_MS;
    const overflow = this.#db.prepare('SELECT feed_sequence FROM webhook_archive WHERE subscription_id = ? ORDER BY feed_sequence DESC LIMIT 1 OFFSET ?')
      .get(id, MAX_ARCHIVE_EVENTS);
    const floor = Number(overflow?.feed_sequence ?? 0);
    const removed = this.#db.prepare(`SELECT MAX(feed_sequence) AS sequence, MAX(created_at) AS at FROM webhook_archive
      WHERE subscription_id = ? AND (created_at <= ? OR feed_sequence <= ?)`).get(id, cutoff, floor)!;
    if (removed.sequence !== null) {
      this.#db.prepare('UPDATE webhook_health SET archive_floor = MAX(archive_floor, ?), archive_floor_at = MAX(COALESCE(archive_floor_at, 0), ?) WHERE subscription_id = ?')
        .run(removed.sequence!, removed.at!, id);
      this.#db.prepare('DELETE FROM webhook_archive WHERE subscription_id = ? AND (created_at <= ? OR feed_sequence <= ?)').run(id, cutoff, floor);
    }
  }

  #row(id: string): SubscriptionRow | undefined {
    return this.#db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(id) as SubscriptionRow | undefined;
  }

  #current(id: string, expectedRevision: string): SubscriptionRow {
    const row = this.#row(id);
    if (!row) throw new WebhookConnectionError('not_found');
    if (row.revision !== expectedRevision) throw new WebhookConnectionError('connection_conflict');
    return row;
  }

  #dashboard(id: string, expectedRevision: string): SubscriptionRow {
    const row = this.#current(id, expectedRevision);
    if (row.source !== 'dashboard') throw new WebhookConnectionError('file_managed');
    return row;
  }

  #requireSuccessfulTest(test: DashboardTest): void {
    if (test.result.outcome !== 'delivered') throw new WebhookConnectionError('test_failed');
  }

  #recordTest(id: string, test: DashboardTest): void {
    // Completion order must not let an older, slower test replace a newer test's diagnostic.
    this.#db.prepare(`UPDATE webhook_subscriptions SET last_test_at = ?, last_test_outcome = ?, last_test_status_code = ?
      WHERE id = ? AND (last_test_at IS NULL OR last_test_at <= ?)`)
      .run(test.at, test.result.outcome, test.result.statusCode, id, test.at);
    this.#db.prepare('INSERT INTO webhook_attempts (subscription_id, event_id, attempted_at, status_code, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(id, test.eventId, test.at, test.result.statusCode, test.result.outcome);
    this.#prune();
  }

  #cancel(id: string): void {
    this.#db.prepare('DELETE FROM webhook_archive WHERE subscription_id = ?').run(id);
    this.#db.prepare('DELETE FROM webhook_job_bindings WHERE subscription_id = ?').run(id);
    this.#db.prepare('DELETE FROM webhook_health WHERE subscription_id = ?').run(id);
    for (const table of ['webhook_deliveries', 'credential_deliveries']) {
      this.#db.prepare(`UPDATE webhook_attempts SET outcome = 'cancelled', lease = NULL WHERE lease IN
        (SELECT lease FROM ${table} WHERE subscription_id = ? AND state = 'sending') AND outcome = 'in_progress'`).run(id);
      this.#db.prepare(`UPDATE ${table} SET state = 'cancelled', payload = NULL, lease = NULL, lease_until = NULL
        WHERE subscription_id = ? AND state IN ('pending', 'sending')`).run(id);
    }
  }

  #prune(): void {
    // Payloads are cleared on completion; only the bounded pending queue retains content. No active row is pruned.
    this.#db.exec(`DELETE FROM credential_deliveries WHERE state NOT IN ('pending', 'sending') AND id NOT IN
      (SELECT id FROM credential_deliveries WHERE state NOT IN ('pending', 'sending') ORDER BY id DESC LIMIT ${MAX_HISTORY});`);
    this.#db.exec(`DELETE FROM webhook_deliveries WHERE state NOT IN ('pending', 'sending') AND id NOT IN
      (SELECT id FROM webhook_deliveries WHERE state NOT IN ('pending', 'sending') ORDER BY id DESC LIMIT ${MAX_HISTORY});
      DELETE FROM webhook_attempts WHERE outcome <> 'in_progress' AND id NOT IN
      (SELECT id FROM webhook_attempts ORDER BY id DESC LIMIT ${MAX_HISTORY});
      DELETE FROM webhook_attempts WHERE outcome <> 'in_progress' AND id IN
      (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY subscription_id ORDER BY id DESC) AS n FROM webhook_attempts) WHERE n > ${MAX_ATTEMPTS_PER_SUBSCRIPTION});`);
  }
}
