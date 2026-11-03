import { projectAccess, projectFilter, type ProjectAccess } from '../oauth/projectAccess.ts';
import { randomUUID } from 'node:crypto';
import { validateAttachments, type AttachmentInput } from './attachments.ts';
import { sha256Hex } from '../crypto.ts';
import { transaction, type Database } from '../db/database.ts';
import { GatewayError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { Clock } from '../time.ts';
import { WebhookStore } from '../webhooks/store.ts';
import { readPullRequests, type PullRequest } from './pullRequests.ts';
import type { DelegatedTask } from './derive.ts';
import { readLaunchSpec, type LaunchSpec } from './launchSpec.ts';
import { isTerminal, RUNNING_STATES, TERMINAL_STATES, type JobState } from './states.ts';
import type { ResolvedWorkspace } from './workspace.ts';

export interface Job {
  /**
   * The tracked PRs (up to MAX_TRACKED_PULL_REQUESTS, in key order), null when unknown. This is what events compare, not what
   * anyone sees: show or send it only through `displayPullRequests` (at most MAX_PULL_REQUESTS).
   */
  pullRequests: PullRequest[] | null;
  pullRequestsCheckedAt: number | null;
  id: string;
  clientId: string;
  requestId: string;
  projectAlias: string;
  hostId: string;
  t3ProjectId: string | null;
  state: JobState;
  task: string;
  title: string;
  branch: string;
  runtimeMode: string;
  threadId: string | null;
  threadTitle: string | null;
  /** URL that opens the thread in the T3 app, from the first thread read. Never logged. */
  threadLink: string | null;
  lastRunId: string | null;
  pendingRequestIds: string[];
  latestMessageExcerpt: string | null;
  /** The excerpt stops short of the worker's message (T3 cut it, or it is longer than the excerpt bound). */
  latestMessageTruncated: boolean;
  latestActivityAt: number | null;
  /** The `afterPosition` for the next incremental `t3_thread_read` of the messages view; null reads from the start. */
  readPosition: number | null;
  /**
   * The `afterPosition` for the next incremental read of the activity view, where delegated work shows
   * (see activity.ts). Null reads from the start, except on a standing job, which is scanned as at adoption.
   */
  activityPosition: number | null;
  hostUnreachableSince: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: number;
  /** When substantive job data last changed. A freshness-only PR check leaves it unchanged. */
  updatedAt: number;
  /** When the job entered its current state. */
  stateChangedAt: number;
  dispatchStartedAt: number | null;
  finishedAt: number | null;
  /**
   * An existing T3 thread the operator adopted (`jobs adopt`), not one the gateway launched. Never
   * launched or reconciled, holds no concurrency slot, and stays open until the operator releases it.
   */
  standing: boolean;
  origin: 'gateway' | 'standing' | 'adopted';
  adoptedBy: string | null;
  adoptedAt: number | null;
  /**
   * Work the thread delegated to other threads (T3 subagents) that is still running, from its timeline.
   * A coordinator is idle while it waits for such work, and T3 starts its next turn when the work is done.
   * At most MAX_DELEGATED_TASKS (derive.ts); cleared when the job finishes.
   */
  delegatedWork: DelegatedTask[];
  /**
   * Running delegated tasks beyond the ones in `delegatedWork`, which the gateway does not follow: while
   * above 0 the job counts as waiting on delegated work, until a turn that started after the last were
   * cut (`delegatedUntrackedRunId` is the thread's run then) has finished. Cleared when the job finishes.
   */
  delegatedUntracked: number;
  delegatedUntrackedRunId: string | null;
  /**
   * When the delegated work of this idle job ended (finished, failed or cancelled) without a new turn
   * starting: the `delegated_work_ended` event. Cleared when the job changes state.
   */
  delegatedEndedAt: number | null;
  /**
   * What a job started through a direct target, an explicit model selection or a scratch alias resolved to when it
   * was created (migration 8; `src/jobs/launchSpec.ts`): the dispatcher launches from it. Version 1 is a worktree
   * launch (project id, base ref, runtime mode, model); version 2 is a scratch launch (T3's internal scratch
   * project, no branch, no recorded project name) with the host id and the host default binding, and is why
   * migration 11 exists. Null for alias-only worktree jobs, which dispatch from the config as before, and also
   * when the stored record cannot be read: check `launchSpecUnreadable` before taking null to mean "alias job".
   */
  launchSpec: LaunchSpec | null;
  /**
   * The stored launch spec could not be read (damaged, or written by a build that knows more), so `launchSpec` is
   * null without the job being an alias job. Such a job is never launched: the dispatcher fails it. One that
   * already has a thread is followed as usual, and views leave out what only the spec said. Reading it never fails.
   */
  launchSpecUnreadable: boolean;
  /**
   * Where the dispatcher resolved the job's workspace (migration 12): `root` is the project's own folder, `worktree` a fresh
   * worktree. Null until a version 3 job is dispatched, and always for other jobs (see `launchSpec`).
   */
  workspaceKind: 'root' | 'worktree' | null;
  /** A hash of the host and the canonical folder of a root job: two jobs with the same key share a folder. Never shown. */
  workspaceRootKey: string | null;
  /**
   * When the job began to hold its folder (the reservation, see `holdsRoot`); null while it does not. At most one job per host
   * and folder holds it: the ledger refuses a second, atomically.
   */
  workspaceRootHeldAt: number | null;
  /**
   * Opaque tokens of the follow-ups and answers the gateway has begun to send to this idle job and that no outcome has settled
   * (see `reserveRoot`). Never shown or logged.
   */
  workspaceResumeTokens: string[];
  /** Probes that could not reach the host for this queued job, and the earliest time of the next try (migration 12). */
  probeAttempts: number;
  probeRetryAt: number | null;
}

/**
 * Whether a job occupies its folder: it may be changing it. Every state that holds a concurrency slot does (`unknown` and
 * `cancel_requested` included: a launch may have happened, an interrupt may not have landed), and so does an idle
 * coordinator whose delegated work still runs, because T3 starts its next turn by itself when that work ends. An idle
 * job with nothing delegated, a queued job and a finished one do not.
 */
export function holdsRoot(state: JobState, delegatedWork: readonly unknown[], delegatedUntracked: number): boolean {
  return RUNNING_STATES.includes(state) || (state === 'idle' && (delegatedWork.length > 0 || delegatedUntracked > 0));
}

/** The client id recorded on standing jobs: the operator adopted them, no agent started them. Real client ids are longer. */
export const OPERATOR_CLIENT_ID = 'operator';

/** Why an event happened. Gateway-generated values only: never task text or worker content. */
export interface EventDetail {
  reason?: string;
  code?: string;
  requestId?: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  type: string;
  fromState: JobState | null;
  toState: JobState | null;
  detail: EventDetail;
  createdAt: number;
}

/** Fields a transition or update may change. */
export type JobChanges = Partial<
  Pick<
    Job,
    | 't3ProjectId'
    | 'threadId'
    | 'threadTitle'
    | 'threadLink'
    | 'lastRunId'
    | 'pendingRequestIds'
    | 'latestMessageExcerpt'
    | 'latestMessageTruncated'
    | 'latestActivityAt'
    | 'readPosition'
    | 'activityPosition'
    | 'hostUnreachableSince'
    | 'lastErrorCode'
    | 'lastErrorMessage'
    | 'dispatchStartedAt'
    | 'delegatedWork'
    | 'delegatedUntracked'
    | 'delegatedUntrackedRunId'
    | 'delegatedEndedAt'
    | 'branch'
    | 'workspaceKind'
    | 'workspaceRootKey'
    | 'probeAttempts'
    | 'probeRetryAt'
    | 'pullRequests'
    | 'pullRequestsCheckedAt'
  >
>;

const COLUMNS: Record<keyof JobChanges, string> = {
  t3ProjectId: 't3_project_id',
  threadId: 't3_thread_id',
  threadTitle: 't3_thread_title',
  threadLink: 't3_thread_link',
  lastRunId: 'last_run_id',
  pendingRequestIds: 'pending_request_ids',
  latestMessageExcerpt: 'latest_message_excerpt',
  latestMessageTruncated: 'latest_message_truncated',
  latestActivityAt: 'latest_activity_at',
  readPosition: 'read_position',
  activityPosition: 'activity_position',
  hostUnreachableSince: 'host_unreachable_since',
  lastErrorCode: 'last_error_code',
  lastErrorMessage: 'last_error_message',
  dispatchStartedAt: 'dispatch_started_at',
  delegatedWork: 'delegated_work',
  delegatedUntracked: 'delegated_untracked',
  delegatedUntrackedRunId: 'delegated_untracked_run_id',
  delegatedEndedAt: 'delegated_ended_at',
  branch: 'branch',
  workspaceKind: 'workspace_kind',
  workspaceRootKey: 'workspace_root_key',
  probeAttempts: 'probe_attempts',
  probeRetryAt: 'probe_retry_at',
  pullRequests: 'pull_requests',
  pullRequestsCheckedAt: 'pull_requests_checked_at',
};

interface JobRow {
  pull_requests: string | null;
  pull_requests_checked_at: number | null;
  id: string;
  client_id: string;
  request_id: string;
  project_alias: string;
  host_id: string;
  t3_project_id: string | null;
  state: JobState;
  task: string;
  title: string;
  branch: string;
  runtime_mode: string;
  t3_thread_id: string | null;
  t3_thread_title: string | null;
  t3_thread_link: string | null;
  last_run_id: string | null;
  pending_request_ids: string;
  latest_message_excerpt: string | null;
  latest_message_truncated: number;
  latest_activity_at: number | null;
  read_position: number | null;
  activity_position: number | null;
  host_unreachable_since: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
  state_changed_at: number;
  dispatch_started_at: number | null;
  finished_at: number | null;
  standing: number;
  origin: Job['origin'];
  adopted_by: string | null;
  adopted_at: number | null;
  delegated_work: string;
  delegated_untracked: number;
  delegated_untracked_run_id: string | null;
  delegated_ended_at: number | null;
  launch_spec: string | null;
  workspace_kind: 'root' | 'worktree' | null;
  workspace_root_key: string | null;
  workspace_root_held_at: number | null;
  workspace_resume_tokens: string;
  probe_attempts: number;
  probe_retry_at: number | null;
}

interface EventRow {
  id: number;
  job_id: string;
  type: string;
  from_state: JobState | null;
  to_state: JobState | null;
  detail: string | null;
  created_at: number;
}

/**
 * The `mine` filter, with the agent's client id as its parameter: the jobs that agent started, and every
 * standing job. No agent starts a standing job (the operator adopts it), but agents drive it as they do
 * their own, so leaving it out would hide the coordinator an agent works with.
 */
const MINE = '(jobs.client_id = ? OR jobs.standing = 1)';

/**
 * What one agent may see: `clientId` applies the `mine` filter (MINE), and `hostIds` limits rows to jobs on those
 * hosts (an agent whose grant covers selected hosts only; none matches nothing). Both apply in SQL, before any limit,
 * so jobs the agent may not see never take a place on its page.
 */
export interface JobScope {
  projects?: ProjectAccess;
  clientId?: string | undefined;
  /** Operator standing jobs retain host-grant access; only client imports require the extra read opt-in. */
  includeAdopted?: boolean | undefined;
  hostIds?: readonly string[] | undefined;
  /** Only jobs in one T3 project of one host (`work_list.target`); a queued alias-only job has no project id yet. */
  target?: { hostId: string; projectId: string } | undefined;
}

function scopeClause(scope: JobScope): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (scope.includeAdopted === false) parts.push("jobs.origin <> 'adopted'");
  if (scope.clientId !== undefined) {
    parts.push(MINE);
    params.push(scope.clientId);
  }
  if (scope.hostIds !== undefined) {
    parts.push(scope.hostIds.length === 0 ? '0' : `jobs.host_id IN (${scope.hostIds.map(() => '?').join(', ')})`);
    params.push(...scope.hostIds);
  }
  const projects = projectFilter(scope.projects);
  parts.push(`(${projects.sql})`);
  params.push(...projects.params);
  if (scope.target !== undefined) {
    parts.push('jobs.host_id = ? AND jobs.t3_project_id = ?');
    params.push(scope.target.hostId, scope.target.projectId);
  }
  return { sql: parts.map((part) => `AND ${part}`).join(' '), params };
}

/** The error for a job id that is unknown, or that the caller may not see: the two are indistinguishable. */
export function jobNotFound(id: string): GatewayError {
  return new GatewayError('not_found', `No job ${id}. Use work_list to see jobs.`);
}

/** Placeholders for TERMINAL_STATES in `state NOT IN (…)`. */
const NOT_OPEN = TERMINAL_STATES.map(() => '?').join(', ');

function parseIds(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseDelegated(text: string): DelegatedTask[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (task): task is DelegatedTask =>
        typeof task === 'object' && task !== null && typeof task.itemId === 'string' && Number.isInteger(task.position) && typeof task.title === 'string',
    );
  } catch {
    return [];
  }
}

function parseStoredPullRequests(text: string | null): PullRequest[] | null {
  try { return text === null ? null : readPullRequests(JSON.parse(text)); } catch { return null; }
}

function toJob(row: JobRow): Job {
  const stored = readLaunchSpec(row.launch_spec);
  return {
    pullRequests: parseStoredPullRequests(row.pull_requests),
    pullRequestsCheckedAt: row.pull_requests_checked_at,
    id: row.id,
    clientId: row.client_id,
    requestId: row.request_id,
    projectAlias: row.project_alias,
    hostId: row.host_id,
    t3ProjectId: row.t3_project_id,
    state: row.state,
    task: row.task,
    title: row.title,
    branch: row.branch,
    runtimeMode: row.runtime_mode,
    threadId: row.t3_thread_id,
    threadTitle: row.t3_thread_title,
    threadLink: row.t3_thread_link,
    lastRunId: row.last_run_id,
    pendingRequestIds: parseIds(row.pending_request_ids),
    latestMessageExcerpt: row.latest_message_excerpt,
    latestMessageTruncated: row.latest_message_truncated === 1,
    latestActivityAt: row.latest_activity_at,
    readPosition: row.read_position,
    activityPosition: row.activity_position,
    hostUnreachableSince: row.host_unreachable_since,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateChangedAt: row.state_changed_at,
    dispatchStartedAt: row.dispatch_started_at,
    finishedAt: row.finished_at,
    standing: row.standing === 1,
    origin: row.origin,
    adoptedBy: row.adopted_by,
    adoptedAt: row.adopted_at,
    delegatedWork: parseDelegated(row.delegated_work),
    delegatedUntracked: row.delegated_untracked,
    delegatedUntrackedRunId: row.delegated_untracked_run_id,
    delegatedEndedAt: row.delegated_ended_at,
    launchSpec: stored.kind === 'spec' ? stored.spec : null,
    launchSpecUnreadable: stored.kind === 'unreadable',
    workspaceKind: row.workspace_kind,
    workspaceRootKey: row.workspace_root_key,
    workspaceRootHeldAt: row.workspace_root_held_at,
    workspaceResumeTokens: parseIds(row.workspace_resume_tokens),
    probeAttempts: row.probe_attempts,
    probeRetryAt: row.probe_retry_at,
  };
}

function toEvent(row: EventRow): JobEvent {
  let detail: EventDetail = {};
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as EventDetail;
    } catch {
      detail = {};
    }
  }
  return { id: row.id, jobId: row.job_id, type: row.type, fromState: row.from_state, toState: row.to_state, detail, createdAt: row.created_at };
}

function columnValue(key: keyof JobChanges, value: JobChanges[keyof JobChanges]): string | number | null {
  if (key === 'pullRequests') return value === null ? null : JSON.stringify(value);
  if (key === 'pendingRequestIds' || key === 'delegatedWork') return JSON.stringify(value ?? []);
  if (typeof value === 'boolean') return value ? 1 : 0;
  // T3 positions are integers; the STRICT INTEGER column refuses anything else.
  return (value ?? null) as string | number | null;
}

export interface FeedEvent extends JobEvent {
  projectAlias: string;
  title: string;
  hostId: string;
  t3ProjectId: string | null;
}

/** Tools whose requestId makes a call idempotent. Keys are scoped per agent and per tool. */
export type IdempotentTool = 'work_start' | 'work_continue' | 'work_settle' | 'work_adopt';

export interface IdempotencyKey {
  inputHash: string;
  jobId: string;
  /** A completed result, private send-retry metadata/uncertainty marker, or null before delivery. */
  response: string | null;
}

export interface NewJob {
  id: string;
  clientId: string;
  requestId: string;
  inputHash: string;
  /** A configured alias, or for a job targeted by T3 project id without one, the internal ref `@<host>/<projectId>`. */
  projectAlias: string;
  hostId: string;
  task: string;
  title: string;
  branch: string;
  runtimeMode: string;
  /** Known at creation for jobs with a launch spec; alias-only jobs learn it at dispatch. */
  t3ProjectId?: string | null;
  launchSpec?: LaunchSpec | null;
  attachments?: AttachmentInput[];
}

/** An existing T3 thread the operator adopts as a standing job, with its state from a first read. */
export interface NewStandingJob {
  id: string;
  projectAlias: string;
  hostId: string;
  t3ProjectId: string;
  state: JobState;
  title: string;
  branch: string;
  runtimeMode: string;
  threadId: string;
  threadTitle: string;
  threadLink: string | null;
  lastRunId: string | null;
  pendingRequestIds: string[];
  latestMessageExcerpt: string | null;
  latestMessageTruncated: boolean;
  latestActivityAt: number | null;
  readPosition: number | null;
  activityPosition: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  delegatedWork: DelegatedTask[];
  delegatedUntracked: number;
  delegatedUntrackedRunId: string | null;
}

/** Resume attempts at once that no outcome has settled, per job; beyond this a resume is refused as busy. */
const MAX_RESUME_ATTEMPTS = 8;

/** What a write found out beyond what it wrote. */
interface WriteOutcome {
  /** The job now occupies a folder that another job on its host holds. */
  contended: boolean;
}

/** What an agent sees while its job waits for another job to give up the project's folder. */
const ROOT_BUSY_MESSAGE =
  "Waiting: another gateway job is working in this project's own folder (workspace root). It starts when that job is finished or idle.";

export interface TransitionOptions {
  /** An observation must still match its source snapshot, including when the state stayed the same. */
  expected?: Job;
  events?: { type: string; detail?: EventDetail }[];
  gatewayTurn?: { runId: string; clientId: string };
  /** The observed active/latest run; lastRunId can still be the older run the watcher is following. */
  turnRunId?: string | null;
  /** The transition happens only if the job is in one of these states. */
  from: readonly JobState[];
  to: JobState;
  changes?: JobChanges;
  detail?: EventDetail;
}

/**
 * The job ledger: jobs, their append-only event log (whose ids are the feed cursor) and request-id
 * idempotency. Every state change goes through `transition`, which updates the row only from an
 * expected state and appends the event in the same transaction.
 */
export class JobStore {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #webhooks: WebhookStore;
  /** Jobs whose unreadable launch spec this process has already reported: once per job, not once per read. */
  readonly #reportedUnreadable = new Set<string>();

  constructor(db: Database, clock: Clock, logger: Logger, webhooks = new WebhookStore(db, clock)) {
    this.#db = db;
    this.#clock = clock;
    this.#logger = logger;
    this.#webhooks = webhooks;
  }

  /** A job from its row. A launch spec that cannot be read is flagged on the job and reported (ids and state only, never the text). */
  readonly #job = (row: JobRow): Job => {
    const job = toJob(row);
    if (job.launchSpecUnreadable && !this.#reportedUnreadable.has(job.id)) {
      this.#reportedUnreadable.add(job.id);
      this.#logger.warn('job.launch_spec_unreadable', { jobId: job.id, hostId: job.hostId, state: job.state });
    }
    return job;
  };

  projectAccess(clientId: string): ProjectAccess {
    return projectAccess(this.#db, clientId);
  }

  get(id: string, scope: JobScope = {}): Job | undefined {
    const filter = scopeClause(scope);
    const row = this.#db.prepare(`SELECT * FROM jobs WHERE id = ? ${filter.sql}`).get(id, ...filter.params) as JobRow | undefined;
    return row && this.#job(row);
  }

  require(id: string): Job {
    const job = this.get(id);
    if (!job) throw jobNotFound(id);
    return job;
  }

  /** Jobs newest first, optionally filtered. `clientId` and `hostIds`: see JobScope. */
  list(filter: { projectAlias?: string; states?: readonly JobState[]; limit: number } & JobScope): Job[] {
    const where: string[] = ['1'];
    const params: (string | number)[] = [];
    if (filter.projectAlias !== undefined) {
      where.push('project_alias = ?');
      params.push(filter.projectAlias);
    }
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    const scope = scopeClause(filter);
    const rows = this.#db
      .prepare(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ${scope.sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, ...scope.params, filter.limit) as unknown as JobRow[];
    return rows.map(this.#job);
  }

  /** Jobs on a host in the given states, oldest first. */
  onHost(hostId: string, states: readonly JobState[]): Job[] {
    const rows = this.#db
      .prepare(`SELECT * FROM jobs WHERE host_id = ? AND state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at, rowid`)
      .all(hostId, ...states) as unknown as JobRow[];
    return rows.map(this.#job);
  }

  /**
   * Queued jobs on a host in FIFO order that the dispatcher may try now. Left out, in SQL and before the limit so they take no place
   * in the window: a job whose probe asked to wait (`probeRetryAt` after `now`; no `now` leaves that out of the check), and a
   * job whose folder (found by an earlier attempt) another job on the host holds, which cannot launch before that job releases it.
   */
  queued(hostId: string, limit: number, options: { now?: number } = {}): Job[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM jobs WHERE host_id = ? AND state = 'queued'
           AND (probe_retry_at IS NULL OR probe_retry_at <= ?)
           AND NOT (workspace_root_key IS NOT NULL AND EXISTS (
             SELECT 1 FROM jobs holder WHERE holder.host_id = jobs.host_id AND holder.workspace_root_key = jobs.workspace_root_key
               AND holder.workspace_root_held_at IS NOT NULL))
         ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(hostId, options.now ?? Number.MAX_SAFE_INTEGER, limit) as unknown as JobRow[];
    return rows.map(this.#job);
  }

  /** Jobs holding one of the host's concurrency slots. Standing jobs never do. */
  slotHolders(hostId: string): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE host_id = ? AND standing = 0 AND state IN (${RUNNING_STATES.map(() => '?').join(', ')})`)
      .get(hostId, ...RUNNING_STATES) as { n: number };
    return row.n;
  }

  /** Ids of every job that is not finished. */
  openJobIds(): Set<string> {
    const rows = this.#db.prepare(`SELECT id FROM jobs WHERE state NOT IN (${NOT_OPEN})`).all(...TERMINAL_STATES) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  hasOpenJobs(hostId: string): boolean {
    const row = this.#db.prepare(`SELECT 1 AS present FROM jobs WHERE host_id = ? AND state NOT IN (${NOT_OPEN}) LIMIT 1`).get(hostId, ...TERMINAL_STATES);
    return row !== undefined;
  }

  /** The open job following a T3 thread, if any. */
  openJobForThread(threadId: string, hostId?: string): Job | undefined {
    const row = this.#db
      .prepare(`SELECT * FROM jobs WHERE t3_thread_id = ? AND state NOT IN (${NOT_OPEN}) ${hostId === undefined ? '' : 'AND host_id = ?'} ORDER BY created_at, rowid LIMIT 1`)
      .get(threadId, ...TERMINAL_STATES, ...(hostId === undefined ? [] : [hostId])) as JobRow | undefined;
    return row && this.#job(row);
  }

  /** Any recorded owner, including finished gateway jobs and released adoptions; thread ids are host-local. */
  jobForThread(hostId: string, threadId: string, scope: JobScope = {}): Job | undefined {
    const filter = scopeClause(scope);
    const row = this.#db.prepare(`SELECT * FROM jobs WHERE host_id = ? AND t3_thread_id = ? ${filter.sql} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(hostId, threadId, ...filter.params) as JobRow | undefined;
    return row && this.#job(row);
  }

  /** Durable content-free audit of accepted adoptions and authorized control attempts, including replays. */
  auditThread(job: Job, clientId: string, action: 'adopt' | 'adopt_replayed' | 'continue' | 'respond' | 'settle' | 'interrupt' | 'release'): void {
    if (job.origin === 'gateway' || job.threadId === null) return;
    this.#db.prepare('INSERT INTO thread_action_events (client_id, host_id, thread_id, job_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(clientId, job.hostId, job.threadId, job.id, action, this.#clock());
    this.#logger.info('threads.control', { clientId, hostId: job.hostId, jobId: job.id, action });
  }

  /** Open standing jobs, oldest first; all of them, or one project's. */
  standingJobs(projectAlias?: string, scope: JobScope = {}): Job[] {
    const filter = scopeClause(scope);
    const project = projectAlias === undefined ? '' : 'AND project_alias = ?';
    const rows = this.#db
      .prepare(`SELECT * FROM jobs WHERE standing = 1 AND state NOT IN (${NOT_OPEN}) ${project} ${filter.sql} ORDER BY created_at, rowid`)
      .all(...TERMINAL_STATES, ...(projectAlias === undefined ? [] : [projectAlias]), ...filter.params) as unknown as JobRow[];
    return rows.map(this.#job);
  }

  /**
   * Insert a queued job with its first event, or return the existing job for a repeated request.
   * The same (client, requestId) for work_start with a different input is rejected.
   */
  create(job: NewJob, scope: JobScope = {}): { job: Job; created: boolean } {
    return transaction(this.#db, () => {
      const existing = this.idempotencyKey(job.clientId, 'work_start', job.requestId);
      if (existing) {
        const replayed = this.get(existing.jobId, scope);
        if (!replayed) {
          throw new GatewayError(
            'insufficient_scope',
            `requestId "${job.requestId}" belongs to a job on a host this agent may not operate on. Use a new requestId for new work.`,
          );
        }
        if (existing.inputHash !== job.inputHash) {
          throw new GatewayError(
            'request_id_conflict',
            `requestId "${job.requestId}" was already used for a different request. Use a new requestId for new work.`,
          );
        }
        return { job: replayed, created: false };
      }
      const now = this.#clock();
      this.#db
        .prepare(
          `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, state, task, title, branch, runtime_mode, created_at, updated_at, state_changed_at,
             t3_project_id, launch_spec)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id, job.clientId, job.requestId, job.projectAlias, job.hostId, job.task, job.title, job.branch, job.runtimeMode, now, now, now,
          job.t3ProjectId ?? null, job.launchSpec ? JSON.stringify(job.launchSpec) : null,
        );
      if (job.attachments?.length) this.#db.prepare('INSERT INTO job_launch_attachments (job_id, payload) VALUES (?, ?)')
        .run(job.id, JSON.stringify(job.attachments));
      this.#insertEvent(job.id, 'created', null, 'queued', {}, now);
      this.#db
        .prepare('INSERT INTO idempotency_keys (client_id, request_id, tool, input_hash, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(job.clientId, job.requestId, 'work_start', job.inputHash, job.id, now);
      this.#logger.info('job.created', { jobId: job.id, project: job.projectAlias, hostId: job.hostId, clientId: job.clientId });
      return { job: this.require(job.id), created: true };
    });
  }

  /**
   * Record an adopted T3 thread as a standing job, with a `created` event (reason `adopted`) in its
   * first state. Adopting a thread that an open standing job of the same project already follows
   * returns that job; a thread followed by any other open job is refused.
   */
  adopt(job: NewStandingJob, adoption?: { clientId: string; requestId: string; inputHash: string }): { job: Job; created: boolean } {
    return transaction(this.#db, () => {
      if (adoption) {
        const key = this.idempotencyKey(adoption.clientId, 'work_adopt', adoption.requestId);
        if (key) {
          if (key.inputHash !== adoption.inputHash) throw new GatewayError('request_id_conflict', 'This requestId was used for a different adoption.');
          const replay = this.require(key.jobId);
          if (replay.hostId !== job.hostId) throw new GatewayError('insufficient_scope', 'The earlier adoption is on a different host.');
          return { job: replay, created: false };
        }
      }
      const existing = adoption ? this.jobForThread(job.hostId, job.threadId) : this.openJobForThread(job.threadId, job.hostId);
      if (existing) {
        if (existing.standing && (adoption
          ? existing.origin === 'adopted' && existing.t3ProjectId === job.t3ProjectId
          : existing.projectAlias === job.projectAlias)) {
          if (adoption) this.claimIdempotencyKey(adoption.clientId, 'work_adopt', adoption.requestId, { inputHash: adoption.inputHash, jobId: existing.id });
          return { job: existing, created: false };
        }
        const what = existing.standing ? `standing job ${existing.id} in project "${existing.projectAlias}"` : `job ${existing.id}, which the gateway launched`;
        throw new GatewayError('job_state_conflict', `Thread ${job.threadId} is already followed by ${what} (${existing.state}).`);
      }
      const now = this.#clock();
      this.#db
        .prepare(
          `INSERT INTO jobs (id, client_id, request_id, project_alias, host_id, t3_project_id, state, task, title, branch, runtime_mode,
             t3_thread_id, t3_thread_title, t3_thread_link, last_run_id, pending_request_ids, latest_message_excerpt, latest_activity_at,
             read_position, last_error_code, last_error_message, created_at, updated_at, state_changed_at, finished_at, standing, delegated_work,
             activity_position, delegated_untracked, delegated_untracked_run_id, latest_message_truncated)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          adoption?.clientId ?? OPERATOR_CLIENT_ID,
          adoption?.requestId ?? 'adopted',
          job.projectAlias,
          job.hostId,
          job.t3ProjectId,
          job.state,
          job.title,
          job.branch,
          job.runtimeMode,
          job.threadId,
          job.threadTitle,
          job.threadLink,
          job.lastRunId,
          JSON.stringify(job.pendingRequestIds),
          job.latestMessageExcerpt,
          job.latestActivityAt,
          job.readPosition,
          job.lastErrorCode,
          job.lastErrorMessage,
          now,
          now,
          now,
          isTerminal(job.state) ? now : null,
          JSON.stringify(job.delegatedWork),
          job.activityPosition,
          job.delegatedUntracked,
          job.delegatedUntrackedRunId,
          job.latestMessageTruncated ? 1 : 0,
        );
      this.#db.prepare('UPDATE jobs SET origin = ?, adopted_by = ?, adopted_at = ? WHERE id = ?')
        .run(adoption ? 'adopted' : 'standing', adoption?.clientId ?? OPERATOR_CLIENT_ID, now, job.id);
      if (adoption) this.claimIdempotencyKey(adoption.clientId, 'work_adopt', adoption.requestId, { inputHash: adoption.inputHash, jobId: job.id });
      this.#insertEvent(job.id, 'created', null, job.state, { reason: 'adopted' }, now);
      this.auditThread(this.require(job.id), adoption?.clientId ?? OPERATOR_CLIENT_ID, 'adopt');
      this.#logger.info('job.adopted', { jobId: job.id, project: job.projectAlias, hostId: job.hostId, state: job.state });
      return { job: this.require(job.id), created: true };
    });
  }

  /**
   * Move a job to `to` if it is currently in one of `from`, applying `changes` and appending a
   * `state_changed` event. Returns the updated job, or undefined when the job was in another state.
   * `to` may equal the current state: then only the changes are applied, guarded by that state.
   */
  transition(id: string, options: TransitionOptions): Job | undefined {
    return transaction(this.#db, () => this.#transition(id, options));
  }

  #transition(id: string, options: TransitionOptions): Job | undefined {
    const current = this.get(id);
    if (!current || !options.from.includes(current.state)) return undefined;
    if (options.expected && JSON.stringify(current) !== JSON.stringify(options.expected)) return undefined;
    if (options.gatewayTurn) this.#recordTurn(id, options.gatewayTurn.runId, options.gatewayTurn.clientId);
    const now = this.#clock();
    const outcome: WriteOutcome = { contended: false };
    if (!this.#write(current, options.changes ?? {}, now, options.to, outcome)) return current;
    if (current.state !== options.to) {
      this.#insertEvent(id, 'state_changed', current.state, options.to, options.detail ?? {}, now, options.turnRunId);
      this.#logger.info('job.state_changed', {
        jobId: id,
        from: current.state,
        to: options.to,
        reason: options.detail?.reason,
        errorCode: options.detail?.code,
      });
    }
    if (!['queued', 'dispatching', 'cancel_requested'].includes(options.to)) this.clearLaunchAttachments(id);
    for (const event of options.events ?? []) this.#insertEvent(id, event.type, current.state, options.to, event.detail ?? {}, now, options.turnRunId);
    if (outcome.contended) this.#insertContended(id, options.to, now);
    return this.get(id);
  }

  /**
   * Claim a queued job for launch with the workspace the dispatcher resolved for it, in one transaction. A root job takes the
   * reservation of its folder here: when another job on the host holds it, the job stays queued with the folder recorded
   * (and so left out of `queued` until that job lets go) and `busy` is returned. Otherwise the job moves to `dispatching`
   * with `changes`, holding the folder if it is a root job. `gone`: the job is no longer queued (cancelled meanwhile).
   */
  dispatch(id: string, workspace: ResolvedWorkspace, changes: JobChanges): { kind: 'claimed' | 'busy'; job: Job } | { kind: 'gone' } {
    return transaction(this.#db, () => {
      const current = this.get(id);
      if (!current || current.state !== 'queued') return { kind: 'gone' } as const;
      const resolved: JobChanges = workspace.kind === 'root'
        ? { workspaceKind: 'root', workspaceRootKey: workspace.rootKey, branch: '' }
        : { workspaceKind: 'worktree', workspaceRootKey: null };
      const now = this.#clock();
      if (workspace.kind === 'root' && this.#otherHolder(current.hostId, workspace.rootKey, id)) {
        this.#write(current, {
          ...resolved,
          probeAttempts: 0,
          probeRetryAt: null,
          lastErrorCode: 'workspace_root_busy',
          lastErrorMessage: ROOT_BUSY_MESSAGE,
        }, now);
        return { kind: 'busy', job: this.require(id) } as const;
      }
      const claimed = this.#transition(id, {
        from: ['queued'],
        to: 'dispatching',
        changes: { ...changes, ...resolved, probeAttempts: 0, probeRetryAt: null },
      });
      return claimed ? ({ kind: 'claimed', job: claimed } as const) : ({ kind: 'gone' } as const);
    });
  }

  /**
   * Begin an attempt to resume an idle root job (a follow-up or an answer the gateway is about to send to its thread), before
   * anything is sent. The folder is taken if no other job on the host holds it (`busy` otherwise, and nothing may be sent);
   * a job that is not an idle root job needs nothing. Every attempt gets its own opaque `token`, stored with the job, and
   * restarts the grace period (`workspace_root_held_at` is set to now, whether or not the job already held the folder), so a
   * retry can never be swept while it is in flight. The attempt must end with `abandonResume(token)` if T3 definitely did not
   * take the message; any other end leaves its token, which is the uncertainty: the folder stays held until each attempt settles individually, or the grace period ends without a later attempt.
   */
  reserveRoot(id: string, operationId?: string): { kind: 'not_needed' | 'busy' } | { kind: 'held'; token: string } {
    return transaction(this.#db, () => {
      const job = this.get(id);
      if (!job || job.workspaceRootKey === null || job.state !== 'idle') return { kind: 'not_needed' } as const;
      if (job.workspaceRootHeldAt === null && this.#otherHolder(job.hostId, job.workspaceRootKey, id)) return { kind: 'busy' } as const;
      if (job.workspaceResumeTokens.length >= MAX_RESUME_ATTEMPTS) return { kind: 'busy' } as const;
      const token = `${sha256Hex(operationId ?? randomUUID())}.${randomUUID()}`;
      this.#db
        .prepare('UPDATE jobs SET workspace_root_held_at = ?, workspace_resume_tokens = ? WHERE id = ?')
        .run(this.#clock(), JSON.stringify([...job.workspaceResumeTokens, token]), id);
      return { kind: 'held', token } as const;
    });
  }

  /**
   * The attempt `token` (from `reserveRoot`) definitely did not reach T3. It leaves the job's attempts; only when none is left
   * (no other attempt in flight, none that ended unknown) and the job is at rest (idle, nothing delegated) is the folder given
   * back. A token that is no longer there (its operation settled, or the grace period ended) changes nothing.
   */
  abandonResume(id: string, token: string): void {
    transaction(this.#db, () => this.#settleResume(id, token, false));
  }

  /** A known answer settles its deduplicated operation only. State changes never settle unrelated calls awaiting an answer. */
  settleResume(id: string, token: string): void {
    transaction(this.#db, () => this.#settleResume(id, token, true));
  }

  #settleResume(id: string, token: string, success = true): void {
    const job = this.get(id);
    if (!job || !job.workspaceResumeTokens.includes(token)) return;
    // A known success also resolves retries of the same deduplicated T3 operation, never another follow-up.
    const operation = token.split('.')[0];
    const remaining = job.workspaceResumeTokens.filter((candidate) => success ? candidate.split('.')[0] !== operation : candidate !== token);
    const atRest = !holdsRoot(job.state, job.delegatedWork, job.delegatedUntracked);
    if (remaining.length === 0 && atRest) {
      this.#db.prepare("UPDATE jobs SET workspace_root_held_at = NULL, workspace_resume_tokens = '[]' WHERE id = ?").run(id);
    } else {
      this.#db.prepare('UPDATE jobs SET workspace_resume_tokens = ? WHERE id = ?').run(JSON.stringify(remaining), id);
    }
  }

  /**
   * Release the reservations of idle or terminal jobs on a host that nothing runs behind any more and that have held for longer than
   * `maxAgeMs`: a resume whose outcome stayed unknown and was never followed up (every attempt restarts the period). One bounded statement; a run that did
   * start is seen by the watcher, which moves the job out of idle, and holds again by state. Returns how many were released.
   */
  releaseStaleHolds(hostId: string, now: number, maxAgeMs: number): number {
    const result = this.#db
      .prepare(
        `UPDATE jobs SET workspace_root_held_at = NULL, workspace_resume_tokens = '[]' WHERE host_id = ? AND workspace_root_held_at IS NOT NULL AND workspace_root_held_at < ?
           AND state IN ('idle', ${NOT_OPEN}) AND delegated_work = '[]' AND delegated_untracked = 0`,
      )
      .run(hostId, now - maxAgeMs, ...TERMINAL_STATES);
    return Number(result.changes);
  }

  #otherHolder(hostId: string, key: string, exceptJobId: string): boolean {
    return this.#db
      .prepare('SELECT 1 AS held FROM jobs WHERE host_id = ? AND workspace_root_key = ? AND workspace_root_held_at IS NOT NULL AND id <> ? LIMIT 1')
      .get(hostId, key, exceptJobId) !== undefined;
  }

  #insertContended(jobId: string, state: JobState, now: number): void {
    this.#insertEvent(jobId, 'workspace_root_contended', state, state, { reason: 'workspace_root_busy', code: 'workspace_root_busy' }, now);
    this.#logger.warn('job.workspace_root_contended', { jobId });
  }

  /** Change fields without changing state and without an event. */
  update(id: string, changes: JobChanges): void {
    const current = this.get(id);
    if (!current) return;
    const outcome: WriteOutcome = { contended: false };
    this.#write(current, changes, this.#clock(), undefined, outcome);
    if (outcome.contended) transaction(this.#db, () => this.#insertContended(id, current.state, this.#clock()));
  }

  /** Record an event that is not a state change (for example a follow-up sent to a running job). */
  appendEvent(id: string, type: string, state: JobState, detail: EventDetail = {}): void {
    transaction(this.#db, () => this.#insertEvent(id, type, state, state, detail, this.#clock()));
  }

  /** A confirmed settlement remains acknowledged until subsequent job activity, ordered by event id (not clock). */
  settlementAcknowledged(id: string): boolean {
    const row = this.#db.prepare(`SELECT type FROM job_events WHERE job_id = ?
      AND type NOT IN ('pull_request_opened', 'pull_request_merged') ORDER BY id DESC LIMIT 1`).get(id) as { type: string } | undefined;
    return row?.type === 'thread_settled';
  }

  /** Claim settlement once across concurrent requests/processes. */
  claimSettlement(clientId: string, requestId: string, key: Omit<IdempotencyKey, 'response'>): boolean {
    return transaction(this.#db, () => {
      if (this.idempotencyKey(clientId, 'work_settle', requestId)) return false;
      this.claimIdempotencyKey(clientId, 'work_settle', requestId, key);
      return true;
    });
  }

  /** Settlement confirmation and its feed event commit together; a concurrent confirmation emits once. */
  recordSettlement(id: string, clientId: string, requestId: string, result: { settled: boolean; settledAt: string | null }): void {
    transaction(this.#db, () => {
      if (this.idempotencyKey(clientId, 'work_settle', requestId)?.response !== null) return;
      this.completeIdempotencyKey(clientId, 'work_settle', requestId, JSON.stringify(result));
      const job = this.require(id);
      this.#insertEvent(id, 'thread_settled', job.state, job.state, {}, this.#clock());
    });
  }

  /** Commit a successful send and its idempotency result together. Only a newly started exact run proves its caller. */
  recordSend(id: string, sent: { runId: string; delivery: string }, clientId: string, requestId: string, resumeToken?: string): void {
    transaction(this.#db, () => {
      this.completeIdempotencyKey(clientId, 'work_continue', requestId, JSON.stringify({ runId: sent.runId, delivery: sent.delivery }));
      const job = this.require(id);
      if (isTerminal(job.state)) {
        if (resumeToken !== undefined) this.#settleResume(id, resumeToken);
        return;
      }
      const now = this.#clock();
      if (sent.delivery === 'started') this.#recordTurn(id, sent.runId, clientId);
      const next = job.state === 'idle' ? 'running' : job.state;
      // Queued/steered sends may return the run they joined; they never replace its recorded initiator.
      const outcome: WriteOutcome = { contended: false };
      this.#write(job, { lastRunId: sent.runId, ...(next !== job.state ? { lastErrorCode: null, lastErrorMessage: null } : {}) }, now, next, outcome);
      this.#insertEvent(id, next !== job.state ? 'state_changed' : 'followup_sent', job.state, next,
        { reason: next !== job.state ? 'followup' : sent.delivery }, now);
      if (next !== job.state && job.lastErrorCode === 't3_run_failed') {
        this.#insertEvent(id, 'job_recovered', job.state, next, { reason: 'worker_resumed' }, now, sent.runId);
      }
      if (outcome.contended) this.#insertContended(id, next, now);
      if (next !== job.state) this.#logger.info('job.state_changed', { jobId: id, from: job.state, to: next, reason: 'followup' });
      if (resumeToken !== undefined) this.#settleResume(id, resumeToken);
    });
  }

  #recordTurn(jobId: string, runId: string, clientId: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO job_turns (job_id, run_id, client_id) VALUES (?, ?, ?)').run(jobId, runId, clientId);
  }

  /** Mark every open job on a host as unreachable since `since`, keeping an earlier mark. A change bumps `updatedAt`. */
  markHostUnreachable(hostId: string, since: number): void {
    this.#db
      .prepare(
        'UPDATE jobs SET host_unreachable_since = ?, updated_at = ? ' +
          `WHERE host_id = ? AND host_unreachable_since IS NULL AND state NOT IN (${NOT_OPEN})`,
      )
      .run(since, this.#clock(), hostId, ...TERMINAL_STATES);
  }

  clearHostUnreachable(hostId: string): void {
    this.#db
      .prepare('UPDATE jobs SET host_unreachable_since = NULL, updated_at = ? WHERE host_id = ? AND host_unreachable_since IS NOT NULL')
      .run(this.#clock(), hostId);
  }

  /** The latest events of one job, oldest first. */
  recentEvents(jobId: string, limit: number): JobEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM (SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(jobId, limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** The newest events across all jobs, newest first, with their job's project and title (the operator dashboard). */
  latestEvents(limit: number): FeedEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT job_events.*, jobs.project_alias, jobs.title, jobs.host_id, jobs.t3_project_id FROM job_events JOIN jobs ON jobs.id = job_events.job_id
          ORDER BY job_events.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as (EventRow & { project_alias: string; title: string; host_id: string; t3_project_id: string | null })[];
    return rows.map((row) => ({ ...toEvent(row), projectAlias: row.project_alias, title: row.title, hostId: row.host_id, t3ProjectId: row.t3_project_id }));
  }

  /** How many jobs are in each state, per host. */
  stateCounts(): { hostId: string; state: JobState; standing: boolean; count: number }[] {
    const rows = this.#db
      .prepare('SELECT host_id, state, standing, COUNT(*) AS n FROM jobs GROUP BY host_id, state, standing ORDER BY host_id, state, standing')
      .all() as { host_id: string; state: JobState; standing: number; n: number }[];
    return rows.map((row) => ({ hostId: row.host_id, state: row.state, standing: row.standing === 1, count: row.n }));
  }

  /** Events after `cursor` (exclusive), oldest first, with their job's project and title. `scope`: see JobScope. */
  eventsAfter(cursor: number, limit: number, scope: JobScope = {}): FeedEvent[] {
    const filter = scopeClause(scope);
    const rows = this.#db
      .prepare(
        `SELECT job_events.*, jobs.project_alias, jobs.title, jobs.host_id, jobs.t3_project_id FROM job_events JOIN jobs ON jobs.id = job_events.job_id
          WHERE job_events.id > ? ${filter.sql} ORDER BY job_events.id LIMIT ?`,
      )
      .all(cursor, ...filter.params, limit) as unknown as (EventRow & { project_alias: string; title: string; host_id: string; t3_project_id: string | null })[];
    return rows.map((row) => ({ ...toEvent(row), projectAlias: row.project_alias, title: row.title, hostId: row.host_id, t3ProjectId: row.t3_project_id }));
  }

  /**
   * Jobs that want the agent's attention, most recent change first: blocked or unconfirmed jobs at any
   * age, and jobs that went idle or failed, or whose delegated work ended while idle, within `recentMs`.
   * `scope`: see JobScope.
   */
  attention(now: number, recentMs: number, limit: number, scope: JobScope = {}, excludeSettled = false): Job[] {
    const filter = scopeClause(scope);
    const since = now - recentMs;
    const rows = this.#db
      .prepare(
        `SELECT * FROM jobs
          WHERE (state IN ('needs_input', 'unknown') OR (state IN ('idle', 'failed') AND state_changed_at >= ?)
            OR (state = 'idle' AND delegated_ended_at >= ?)) ${filter.sql}
          ${excludeSettled ? `AND (SELECT type FROM job_events WHERE job_id = jobs.id
            AND type NOT IN ('pull_request_opened', 'pull_request_merged') ORDER BY id DESC LIMIT 1) IS NOT 'thread_settled'` : ''}
          ORDER BY MAX(state_changed_at, COALESCE(delegated_ended_at, 0)) DESC, rowid DESC LIMIT ?`,
      )
      .all(since, since, ...filter.params, limit) as unknown as JobRow[];
    return rows.map(this.#job);
  }

  /** Private queued payload; deliberately absent from Job and every view. */
  launchAttachments(id: string): AttachmentInput[] {
    const row = this.#db.prepare('SELECT payload FROM job_launch_attachments WHERE job_id = ?').get(id) as { payload: string } | undefined;
    try { return row === undefined ? [] : validateAttachments(JSON.parse(row.payload)); }
    catch { throw new GatewayError('database_error', "This job's stored attachments could not be read. Start the work again."); }
  }

  clearLaunchAttachments(id: string): void {
    this.#db.prepare('DELETE FROM job_launch_attachments WHERE job_id = ?').run(id);
  }

  /** No downstream retry key exists for attachment sends. Write the uncertainty before touching that API. */
  beginAttachmentSend(clientId: string, requestId: string): boolean {
    return this.#db.prepare(`UPDATE idempotency_keys SET response = '{"attachmentOutcome":"unknown"}'
      WHERE client_id = ? AND tool = 'work_continue' AND request_id = ? AND response IS NULL`).run(clientId, requestId).changes === 1;
  }

  /** Bind an uncertain plain send to its original authorization identity before touching T3. No credential is stored here. */
  beginTextSend(clientId: string, requestId: string, identity: string, allowNew: boolean): void {
    transaction(this.#db, () => {
      const key = this.idempotencyKey(clientId, 'work_continue', requestId);
      const stored = key?.response == null ? null : JSON.parse(key.response) as { sendIdentity?: string; sendAttempts?: number };
      if (!key || (stored === null && !allowNew) || (stored !== null &&
          (stored.sendIdentity !== identity || typeof stored.sendAttempts !== 'number' ||
            !Number.isSafeInteger(stored.sendAttempts) || stored.sendAttempts < 1))) {
        throw new GatewayError('t3_response_lost', 'The earlier send cannot be safely retried under this T3 authorization. Inspect the thread before starting new work.');
      }
      this.completeIdempotencyKey(clientId, 'work_continue', requestId,
        JSON.stringify({ sendIdentity: identity, sendAttempts: (stored?.sendAttempts ?? 0) + 1 }));
    });
  }

  /** A definite failure can release only a first attempt with no overlapping/repeated attempts. */
  releaseFirstTextSend(clientId: string, requestId: string, identity: string): boolean {
    return this.#db.prepare(`DELETE FROM idempotency_keys
      WHERE client_id = ? AND tool = 'work_continue' AND request_id = ? AND response = ?`)
      .run(clientId, requestId, JSON.stringify({ sendIdentity: identity, sendAttempts: 1 })).changes === 1;
  }

  idempotencyKey(clientId: string, tool: IdempotentTool, requestId: string): IdempotencyKey | undefined {
    const row = this.#db
      .prepare('SELECT input_hash, job_id, response FROM idempotency_keys WHERE client_id = ? AND tool = ? AND request_id = ?')
      .get(clientId, tool, requestId) as { input_hash: string; job_id: string; response: string | null } | undefined;
    return row && { inputHash: row.input_hash, jobId: row.job_id, response: row.response };
  }

  /** Claim a request id for a tool before calling T3, so a retry can tell an earlier attempt happened. */
  claimIdempotencyKey(clientId: string, tool: IdempotentTool, requestId: string, key: Omit<IdempotencyKey, 'response'>): void {
    this.#db
      .prepare('INSERT INTO idempotency_keys (client_id, request_id, tool, input_hash, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(clientId, requestId, tool, key.inputHash, key.jobId, this.#clock());
  }

  completeIdempotencyKey(clientId: string, tool: IdempotentTool, requestId: string, response: string): void {
    this.#db
      .prepare('UPDATE idempotency_keys SET response = ? WHERE client_id = ? AND tool = ? AND request_id = ?')
      .run(response, clientId, tool, requestId);
  }

  /** Release a request id whose call definitely did not happen, so the agent may retry with it. */
  releaseIdempotencyKey(clientId: string, tool: IdempotentTool, requestId: string): void {
    this.#db
      .prepare('DELETE FROM idempotency_keys WHERE client_id = ? AND tool = ? AND request_id = ? AND response IS NULL')
      .run(clientId, tool, requestId);
  }

  /**
   * Write what differs from `current`. Returns false, writing nothing, when nothing differs. A state
   * change clears `delegatedEndedAt`; a finished job follows no delegated work.
   *
   * It also keeps the folder reservation of a root job in step with what the write leaves it doing (`holdsRoot`), in the same
   * statement. A job that now occupies its folder and holds no reservation takes it when no other job on the host holds it;
   * when one does (work T3 itself started in a folder the gateway handed to someone else, which no gateway can prevent) the job
   * is recorded as it is and `outcome.contended` is set. A reservation is given back when the write changes the job's state or its
   * delegated work and leaves it not occupying the folder. A write that changes neither (a poll of an idle job) never
   * releases: a resume takes the reservation before it sends (`reserveRoot`).
   */
  #write(current: Job, changes: JobChanges, now: number, state?: JobState, outcome?: WriteOutcome): boolean {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    let effective = changes;
    if (state !== undefined && state !== current.state) {
      sets.push('state = ?', 'state_changed_at = ?', 'finished_at = ?');
      params.push(state, now, isTerminal(state) ? now : null);
      effective = { ...changes, delegatedEndedAt: null };
      if (isTerminal(state)) effective = { ...effective, delegatedWork: [], delegatedUntracked: 0, delegatedUntrackedRunId: null };
    }
    for (const [key, value] of Object.entries(effective) as [keyof JobChanges, JobChanges[keyof JobChanges]][]) {
      if (value === undefined) continue;
      const next = columnValue(key, value);
      if (next === columnValue(key, current[key])) continue;
      sets.push(`${COLUMNS[key]} = ?`);
      params.push(next);
    }
    const nextState = state ?? current.state;
    const nextWork = effective.delegatedWork ?? current.delegatedWork;
    const nextUntracked = effective.delegatedUntracked ?? current.delegatedUntracked;
    const rootKey = effective.workspaceRootKey === undefined ? current.workspaceRootKey : effective.workspaceRootKey;
    const holds = rootKey !== null && holdsRoot(nextState, nextWork, nextUntracked);
    const occupiedBefore = holdsRoot(current.state, current.delegatedWork, current.delegatedUntracked);
    const stateChanged = nextState !== current.state;
    const moved = stateChanged || JSON.stringify(nextWork) !== JSON.stringify(current.delegatedWork) || nextUntracked !== current.delegatedUntracked;
    // A state change can belong to a sibling call. Only individual settlement (or the bounded stale sweep) ends attempts.
    const resuming = current.workspaceResumeTokens.length > 0;
    if (holds && current.workspaceRootHeldAt === null) {
      if (this.#otherHolder(current.hostId, rootKey, current.id)) {
        if (outcome && !occupiedBefore) outcome.contended = true;
      } else {
        sets.push('workspace_root_held_at = ?');
        params.push(now);
      }
    } else if (!holds && !resuming && current.workspaceRootHeldAt !== null && (moved || rootKey === null)) {
      sets.push('workspace_root_held_at = NULL');
    }
    if (sets.length === 0) return false;
    // A successful poll of unchanged PRs is freshness, not new job activity.
    if (sets.some((set) => set !== 'pull_requests_checked_at = ?')) {
      sets.push('updated_at = ?');
      params.push(now);
    }
    this.#db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params, current.id);
    return true;
  }

  #insertEvent(jobId: string, type: string, from: JobState | null, to: JobState | null, detail: EventDetail, now: number, turnRunId?: string | null): void {
    const json = Object.keys(detail).length > 0 ? JSON.stringify(detail) : null;
    const result = this.#db
      .prepare('INSERT INTO job_events (job_id, type, from_state, to_state, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, type, from, to, json, now);
    this.#webhooks.capture({ id: Number(result.lastInsertRowid), jobId, type, fromState: from, toState: to, detail, createdAt: now }, this.require(jobId), turnRunId);
  }
}
