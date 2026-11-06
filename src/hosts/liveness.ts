import * as z from 'zod';
import { isThreadId, threadLinkTarget } from '../threadId.js';
import { GatewayError, describeError } from '../errors.ts';
import { silentLogger, type Logger } from '../log.ts';
import { isDelegatedWorkActive, isUnsettled } from '../jobs/derive.ts';
import { ACTIVE_RUN_STATUSES, type ThreadItem, type ThreadRead } from '../t3/schemas.ts';
import { HOUR, MINUTE, type Clock } from '../time.ts';
import { CATALOG_TTL_MS, snapshotId, type Snapshot } from './catalog.ts';
import type { HostRegistry } from './registry.ts';
import { cleanThreadTitle, MAX_THREAD_PAGES, THREAD_PAGE_SIZE } from './threads.ts';

/** Threads read in detail per call, at most; more candidates make the report incomplete (`omitted`), never silently clear. */
export const MAX_LIVENESS_READS = 100;
/** Thread ids a caller may name for a direct read (for example a tracked thread that left the non-settled list). */
export const MAX_LIVENESS_IDS = 20;
/** Timeline items read from the end of each thread; activity older than the tail falls back to the run start. */
export const LIVENESS_TAIL = 40;
const TAIL_PAGES = 3;
const CONCURRENCY = 4;
const MAX_SNAPSHOTS = 32;
const MAX_PULL_REQUESTS = 10;
/** Timestamps further in the future than this are not activity. */
const MAX_SKEW_MS = 2 * MINUTE;

/**
 * Timeline items that are the provider's own work: output, reasoning, commands, tools, file changes, searches and plans.
 * User and agent-sent messages, checkpoints, notifications, delegated `subagent` items (a child's progress) and
 * metadata never count as activity.
 */
const ACTIVITY_TYPE = /assistant|reasoning|command|tool|file_change|search|plan|todo|approval/i;
export function isProviderActivity(item: ThreadItem): boolean {
  return item.createdBy !== 'user' && !/user|subagent/i.test(item.type) && ACTIVITY_TYPE.test(item.type);
}

const TERMINAL_RUN = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);

export type LivenessPhase = 'working' | 'waiting' | 'turn_ended' | 'idle';
export type WaitingOn = 'question' | 'approval' | 'request' | 'child' | null;

export interface LivenessRun {
  runId: string;
  ordinal: number;
  status: string;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ThreadLiveness {
  threadId: string;
  link: string | null;
  parentThreadId: string | null;
  title: string;
  status: string;
  phase: LivenessPhase;
  waitingOn: WaitingOn;
  activeRunId: string | null;
  latestRun: LivenessRun | null;
  createdAt: string | null;
  metadataUpdatedAt: string | null;
  observedAt: string;
  settled: boolean | null;
  archived: boolean | null;
  snoozedUntil: string | null;
  /** Newest own-thread provider activity in the active (else latest) run, or that run's start: never metadata or observation time. */
  lastActivityAt: string | null;
  activitySource: 'timeline' | 'run_start' | 'none';
  /** The tail reached the end of the timeline. */
  activityComplete: boolean;
  /** Items of the current run still going (a long command, a streaming message): quiet is then expected. */
  openItems: number;
  /** Delegated tasks the tail shows still going. */
  delegatedActive: number;
  pendingQuestions: number;
  pendingRequests: number;
  approval: 'confirmed' | 'unclassified' | 'none';
  pullRequests: { url: string; repository: string | null; number: number | null; state: string | null }[];
}

export interface LivenessReport {
  host: string;
  projectId: string;
  environmentId: string | null;
  readAt: string;
  /** Every candidate was read and the non-settled list was complete. False never means "nothing is running". */
  complete: boolean;
  /** Non-settled threads T3 listed in the project, delegated children included. */
  listed: number;
  /** Threads that qualified for a detailed read: active, waiting, recently ended, or named by the caller. */
  considered: number;
  /** Candidates beyond MAX_LIVENESS_READS, not read. */
  omitted: number;
  threads: ThreadLiveness[];
  errors: { threadId: string | null; code: string }[];
}

const rowSchema = z.looseObject({
  threadId: z.string(),
  link: z.string().nullish(),
  title: z.string(),
  status: z.string(),
  latestRunId: z.string().nullable().optional(),
  parentThreadId: z.string().nullish(),
  itemCount: z.int().min(0).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
  settled: z.boolean().optional(),
  archived: z.boolean().optional(),
  snoozedUntil: z.string().nullish(),
});
type Row = z.infer<typeof rowSchema>;

const prSchema = z.looseObject({ url: z.string(), repository: z.string().nullish(), number: z.int().nullish(), state: z.string().nullish() });
const runExtra = z.looseObject({ requestedAt: z.string().nullish(), startedAt: z.string().nullish() });
const threadExtra = z.looseObject({
  parentThreadId: z.string().nullish(), itemCount: z.int().min(0).optional(), createdAt: z.string().optional(),
  snoozedUntil: z.string().nullish(), pullRequests: z.array(z.unknown()).optional(),
});

const iso = (value: unknown): string | null => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function pullRequests(value: unknown): ThreadLiveness['pullRequests'] {
  if (!Array.isArray(value)) return [];
  const out: ThreadLiveness['pullRequests'] = [];
  for (const raw of value) {
    const pr = prSchema.safeParse(raw);
    if (!pr.success) continue;
    let url: URL;
    try { url = new URL(pr.data.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || pr.data.url.length > 512) continue;
    out.push({ url: url.href, repository: pr.data.repository?.slice(0, 200) ?? null, number: pr.data.number ?? null, state: pr.data.state?.slice(0, 40) ?? null });
    if (out.length >= MAX_PULL_REQUESTS) break;
  }
  return out;
}

/** The environment a v2 thread link names, if any. */
export function linkEnvironment(link: string | null | undefined): string | null {
  const target = threadLinkTarget(link ?? null);
  const match = target ? /^t3-thread:\/\/v2\/([^/]+)\//.exec(target) : null;
  return match?.[1] ?? null;
}

/**
 * One thread's liveness from a tail read of its activity view and its pending question count. Pure: the rules, in order:
 * a pending question waits on an answer; a confirmed pending approval waits on approval; T3 reporting `waiting` with an
 * unclassified pending request waits on that request; an active run (or active status) is working, whatever its pending
 * count; delegated work still going waits on a child; a terminal latest run ended the turn; otherwise idle.
 */
export function deriveLiveness(read: ThreadRead, items: readonly ThreadItem[], pendingQuestions: number, complete: boolean, now: number): ThreadLiveness {
  const { thread } = read;
  const extra = threadExtra.parse(thread);
  const runs = [...read.recentRuns].sort((a, b) => b.ordinal - a.ordinal);
  const toRun = (run: (typeof runs)[number] | undefined): LivenessRun | null => {
    if (!run) return null;
    const more = runExtra.safeParse(run);
    return { runId: run.runId, ordinal: run.ordinal, status: run.status.slice(0, 40), requestedAt: iso(more.success ? more.data.requestedAt : null),
      startedAt: iso(more.success ? more.data.startedAt : null), completedAt: iso(run.completedAt) };
  };
  const activeRun = thread.activeRunId === null ? undefined : runs.find((run) => run.runId === thread.activeRunId);
  const latest = toRun(runs.find((run) => run.runId === thread.latestRunId) ?? runs[0]);
  const heartbeatRunId = thread.activeRunId ?? thread.latestRunId ?? latest?.runId ?? null;
  const own = items.filter((item) => {
    const source = Reflect.get(item, 'sourceThreadId');
    return source === undefined || source === null || source === thread.threadId;
  });
  const current = own.filter((item) => heartbeatRunId !== null && item.runId === heartbeatRunId);
  const times = current.filter(isProviderActivity).map((item) => Date.parse(item.updatedAt))
    .filter((ms) => Number.isFinite(ms) && ms <= now + MAX_SKEW_MS);
  const heartbeatRun = toRun(runs.find((run) => run.runId === heartbeatRunId));
  const started = heartbeatRun?.startedAt ? Date.parse(heartbeatRun.startedAt) : NaN;
  const baseline = Number.isFinite(started) && started <= now + MAX_SKEW_MS ? started : null;
  const timeline = times.length ? Math.max(...times) : null;
  let lastActivity: number | null = null;
  let activitySource: ThreadLiveness['activitySource'] = 'none';
  if (timeline !== null && (baseline === null || timeline >= baseline)) { lastActivity = timeline; activitySource = 'timeline'; }
  else if (baseline !== null) { lastActivity = baseline; activitySource = 'run_start'; }

  const openItems = current.filter((item) => isUnsettled(item) && !/subagent/i.test(item.type)).length;
  const delegatedActive = own.filter(isDelegatedWorkActive).length;
  const pendingRequests = Math.max(0, thread.pendingRequestCount);
  const unansweredOther = pendingRequests > pendingQuestions;
  const approval = !unansweredOther ? 'none' : own.some((item) => /approval/i.test(item.type) && isUnsettled(item)) ? 'confirmed' : 'unclassified';
  const active = thread.activeRunId !== null || ACTIVE_RUN_STATUSES.includes(thread.status);
  const reportsWaiting = thread.status === 'waiting' || activeRun?.status === 'waiting';

  let phase: LivenessPhase;
  let waitingOn: WaitingOn = null;
  if (pendingQuestions > 0) { phase = 'waiting'; waitingOn = 'question'; }
  else if (approval === 'confirmed') { phase = 'waiting'; waitingOn = 'approval'; }
  else if (approval === 'unclassified' && reportsWaiting) { phase = 'waiting'; waitingOn = 'request'; }
  else if (active) phase = 'working';
  else if (delegatedActive > 0) { phase = 'waiting'; waitingOn = 'child'; }
  else if (latest && TERMINAL_RUN.has(latest.status)) phase = 'turn_ended';
  else phase = 'idle';

  return {
    threadId: thread.threadId,
    link: thread.link ?? null,
    parentThreadId: extra.parentThreadId && isThreadId(extra.parentThreadId) ? extra.parentThreadId : null,
    title: cleanThreadTitle(thread.title),
    status: thread.status.slice(0, 40),
    phase,
    waitingOn,
    activeRunId: thread.activeRunId,
    latestRun: latest,
    createdAt: iso(extra.createdAt),
    metadataUpdatedAt: iso(thread.updatedAt),
    observedAt: new Date(now).toISOString(),
    settled: thread.settled ?? null,
    archived: thread.archived ?? null,
    snoozedUntil: iso(extra.snoozedUntil),
    lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(),
    activitySource,
    activityComplete: complete,
    openItems,
    delegatedActive,
    pendingQuestions,
    pendingRequests,
    approval,
    pullRequests: pullRequests(extra.pullRequests),
  };
}

/** Whether a listed row needs a detailed read: active or waiting, or its latest change is inside the window. */
function qualifies(row: Row, since: number): boolean {
  if (row.settled === true || row.archived === true) return false;
  if (row.status === 'waiting' || ACTIVE_RUN_STATUSES.includes(row.status)) return true;
  if (row.status === 'idle') return false;
  const updated = Date.parse(row.updatedAt);
  return Number.isFinite(updated) && updated >= since;
}

interface Entry {
  snapshot?: Snapshot<LivenessReport>;
  inflight?: Promise<Snapshot<LivenessReport>>;
}

/**
 * Read-only liveness for one project's non-settled threads, delegated children included. Uses only T3 read tools
 * (t3_thread_list, t3_thread_read, the pending-request list) through the gateway's own standalone session: never a
 * send, answer, settle, adoption or watch, and never a thread-scoped identity that could mark a child's result delivered.
 * Authorization and project validation belong to the caller, before this cache is touched.
 */
export class LivenessReader {
  readonly #registry: HostRegistry;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #entries = new Map<string, Entry>();

  constructor(registry: HostRegistry, clock: Clock, logger: Logger = silentLogger) {
    this.#registry = registry;
    this.#clock = clock;
    this.#logger = logger;
  }

  read(host: string, project: string, options: { threadIds?: readonly string[]; withinHours?: number } = {}): Promise<Snapshot<LivenessReport>> {
    const ids = [...new Set(options.threadIds ?? [])].sort();
    const withinHours = options.withinHours ?? 24;
    const key = JSON.stringify([host, project, ids, withinHours]);
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= MAX_SNAPSHOTS) {
        const oldest = [...this.#entries].find(([, value]) => !value.inflight)?.[0];
        if (oldest === undefined) throw new GatewayError('catalog_limit', 'Too many liveness reads are in flight. Try again later.');
        this.#entries.delete(oldest);
      }
      entry = {};
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (entry.snapshot && this.#clock() - entry.snapshot.fetchedAt < CATALOG_TTL_MS) return Promise.resolve(entry.snapshot);
    if (entry.inflight) return entry.inflight;
    const current = entry;
    const pending = this.#fetch(host, project, ids, withinHours).then((value) => {
      const snapshot = { id: snapshotId(), fetchedAt: this.#clock(), value };
      current.snapshot = snapshot;
      return snapshot;
    }).finally(() => { if (current.inflight === pending) current.inflight = undefined; });
    current.inflight = pending;
    return pending;
  }

  async #fetch(host: string, project: string, ids: readonly string[], withinHours: number): Promise<LivenessReport> {
    const client = this.#registry.client(host);
    const errors: LivenessReport['errors'] = [];
    let complete = true;
    const rows = new Map<string, Row>();
    let cursor = 0;
    let total: number | undefined;
    // The list itself failing is a host failure: thrown, so the caller never mistakes it for an empty project.
    for (let page = 0; ; page++) {
      if (page >= MAX_THREAD_PAGES) { complete = false; errors.push({ threadId: null, code: 'catalog_limit' }); break; }
      const result = await client.listThreadCatalogPage({ projectId: project, includeSubagents: true, settled: false, limit: THREAD_PAGE_SIZE, cursor });
      if (result.projectId !== project) throw new GatewayError('t3_invalid_response', 'T3 listed threads of another project.');
      if (total !== undefined && result.total !== total) { complete = false; errors.push({ threadId: null, code: 'list_shifted' }); }
      total = result.total;
      for (const raw of result.threads) {
        const row = rowSchema.safeParse(raw);
        if (!row.success || !isThreadId(row.data.threadId)) { complete = false; errors.push({ threadId: null, code: 'invalid_row' }); continue; }
        rows.set(row.data.threadId, row.data);
      }
      if (result.nextCursor === null) break;
      if (result.nextCursor <= cursor) { complete = false; errors.push({ threadId: null, code: 'list_shifted' }); break; }
      cursor = result.nextCursor;
    }
    const now = this.#clock();
    const since = now - withinHours * HOUR;
    const qualifying = [...rows.values()].filter((row) => qualifies(row, since))
      .sort((a, b) => Number(ACTIVE_RUN_STATUSES.includes(b.status)) - Number(ACTIVE_RUN_STATUSES.includes(a.status)) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const named = ids.filter((id) => isThreadId(id));
    const queue: { threadId: string; itemCount?: number }[] = named.map((threadId) => ({ threadId, itemCount: rows.get(threadId)?.itemCount }));
    for (const row of qualifying) if (!named.includes(row.threadId)) queue.push({ threadId: row.threadId, itemCount: row.itemCount });
    const considered = queue.length;
    const omitted = Math.max(0, considered - MAX_LIVENESS_READS);
    if (omitted) { complete = false; errors.push({ threadId: null, code: 'read_limit' }); }
    const work = queue.slice(0, MAX_LIVENESS_READS);
    const threads: ThreadLiveness[] = [];
    let next = 0;
    const worker = async () => {
      while (next < work.length) {
        const job = work[next++]!;
        try {
          const result = await this.#thread(host, project, job.threadId, job.itemCount);
          if (!result.activityComplete) complete = false;
          threads.push(result);
        } catch (error) {
          complete = false;
          const code = describeError(error).code;
          errors.push({ threadId: job.threadId, code: code === 'internal_error' ? 'read_failed' : code });
          if (code === 'internal_error') this.#logger.warn('liveness.read_failed', { hostId: host });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));
    const order = new Map(work.map((job, index) => [job.threadId, index]));
    threads.sort((a, b) => order.get(a.threadId)! - order.get(b.threadId)!);
    const environmentId = [...rows.values()].map((row) => linkEnvironment(row.link)).find((value) => value !== null)
      ?? threads.map((thread) => linkEnvironment(thread.link)).find((value) => value !== null) ?? null;
    return { host, projectId: project, environmentId, readAt: new Date(this.#clock()).toISOString(), complete,
      listed: rows.size, considered, omitted, threads, errors: errors.slice(0, 50) };
  }

  async #thread(host: string, project: string, threadId: string, itemCount: number | undefined): Promise<ThreadLiveness> {
    const client = this.#registry.client(host);
    const base = { threadId, view: 'activity' as const, runLimit: 5, maxCharsPerItem: 1 };
    let count = itemCount;
    let read: ThreadRead | undefined;
    if (count === undefined) {
      read = await client.readThread({ ...base, limit: 1 });
      const extra = threadExtra.safeParse(read.thread);
      count = extra.success ? extra.data.itemCount : undefined;
      if (read.thread.projectId !== project) throw new GatewayError('not_found', 'That thread is not in this project.');
    }
    const items: ThreadItem[] = [];
    let after = count !== undefined && count > LIVENESS_TAIL ? count - LIVENESS_TAIL - 1 : null;
    let completeTail = false;
    for (let page = 0; page < TAIL_PAGES; page++) {
      read = await client.readThread({ ...base, afterPosition: after, limit: 100 });
      if (read.thread.projectId !== project) throw new GatewayError('not_found', 'That thread is not in this project.');
      items.push(...read.items);
      if (!read.hasMore || read.nextPosition === null) { completeTail = !read.hasMore; break; }
      if (after !== null && read.nextPosition <= after) break;
      after = read.nextPosition;
    }
    const detail = read!;
    const waitingStatus = detail.thread.status === 'waiting';
    const questions = detail.thread.pendingRequestCount > 0 || waitingStatus ? (await client.listPendingRequests(threadId)).length : 0;
    return deriveLiveness(detail, items, questions, completeTail, this.#clock());
  }
}
