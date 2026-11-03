import { allowsProject, expandProjectAccess } from '../oauth/projectAccess.ts';
import { configuredModel, RUNTIME_MODES, runtimeModeAllowed, type GatewayConfig, type HostConfig, type ProjectConfig, type RuntimeMode } from '../config.ts';
import { describeError, GatewayError } from '../errors.ts';
import type { CatalogService } from '../hosts/catalog.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import { resolveProject } from '../hosts/projects.ts';
import type { Logger } from '../log.ts';
import { T3TransportError } from '../t3/client.ts';
import { T3ToolError } from '../t3/results.ts';
import type { LaunchResult, LaunchWorkspaceStrategy, ThreadRead } from '../t3/schemas.ts';
import { MINUTE, SECOND, type Clock } from '../time.ts';
import { readPullRequests, pullRequestEvents } from './pullRequests.ts';
import { readActivity, refreshDelegated, scanActivity } from './activity.ts';
import { EXCERPT_CHARS, isActiveStatus, observe, threadLinkTarget, type ActivityRead } from './derive.ts';
import { deliverInterrupt } from './interrupt.ts';
import { validateSelection, type LaunchSpec, type ModelSelection } from './launchSpec.ts';
import { jobMarker } from './service.ts';
import type { Job, JobChanges, JobStore } from './store.ts';
import { launchPolicy, mapProjects } from './targets.ts';
import { probeRequest, resolveWorkspace, runWorkspaceProbe, type ResolvedWorkspace, type WorkspaceIntent } from './workspace.ts';

/** Launches can take a while: T3 prepares the worktree before answering. */
const LAUNCH_TIMEOUT_MS = 60 * SECOND;
const MAX_BACKOFF_MS = 5 * MINUTE;
/** Idle jobs are only checked for activity started from T3 itself, so less often. */
const IDLE_POLL_MS = MINUTE;
/** Pages of new messages-view items read per job per tick (activity view: see activity.ts). */
const MAX_READ_PAGES = 5;
const READ_PAGE_SIZE = 100;
const RECENT_RUNS = 5;
/** What a queued job fails with when the launch plan stored with it cannot be read. Fixed text: the stored text is never repeated. */
const UNREADABLE_PLAN = "This job's stored launch plan could not be read. Start the work again.";
/** Times one tick fails unreadable queued jobs and looks again; a ledger with more of them is cleared over the next ticks. */
const MAX_UNREADABLE_ROUNDS = 10;

/**
 * Queued jobs the dispatcher looks at beyond the free slots, so a job that cannot launch now (its probe failed, its folder is
 * busy) does not hide the ones behind it; rounds and probes bound the work one tick does for a host.
 */
const DISPATCH_SLACK = 4;
const DISPATCH_ROUNDS = 4;
const MAX_PROBES_PER_TICK = 8;
/** Probe attempts a job gets when the probe cannot reach its host (timeout, ssh exit 255), spaced by the tick interval, doubling. */
const MAX_PROBE_ATTEMPTS = 3;
/** An idle job holding its folder for a resume that never showed itself gives it up after this long. */
const RESUME_GRACE_MS = 10 * MINUTE;

/** Error codes that mean the host as a whole cannot be used right now. */
const HOST_FAILURES = new Set(['host_unreachable', 't3_timeout', 't3_response_lost', 't3_unauthorized', 'host_not_enrolled']);

/**
 * T3 launch error codes that mean T3 refused before creating anything: the input was rejected (for
 * example no model selection where the project has no default), or the project or capability is
 * missing.
 */
const REFUSED_BEFORE_CREATION = new Set(['invalid_request', 'target_required', 'capability_denied', 'project_not_found']);

/** A job's thread as found or launched; `threadLink` is the app URL, when T3 gave a usable one. */
interface FoundThread {
  threadId: string;
  threadTitle: string;
  lastRunId: string | null;
  threadLink: string | null;
  /** The thread's T3 status, for a thread found by a lookup. */
  status?: string;
}

function foundThread(thread: { threadId: string; title: string; latestRunId: string | null; link: string | null; status: string }): FoundThread {
  const { threadId, title, latestRunId, link, status } = thread;
  return { threadId, threadTitle: title, lastRunId: latestRunId, threadLink: threadLinkTarget(link), status };
}

function isHostFailure(error: unknown): error is GatewayError {
  return error instanceof GatewayError && !(error instanceof T3ToolError) && HOST_FAILURES.has(error.code);
}

/**
 * Whether the runtime mode a queued job will launch with is still allowed: within the host's access ceiling and no broader
 * than the runtime mode the job's project policy (its alias, or the host's discovery policy) has now. A job accepted under a
 * broader policy is never launched with it, and never silently given another mode.
 */
function runtimeModeFits(mode: string, host: HostConfig, policy: RuntimeMode): boolean {
  const known = RUNTIME_MODES.find((candidate) => candidate === mode);
  return known !== undefined && runtimeModeAllowed(known, host.access) && RUNTIME_MODES.indexOf(known) <= RUNTIME_MODES.indexOf(policy);
}

/** Appended to every task so the worker (and anyone reading the thread) knows where it came from. */
export function launchMessage(job: Job, standingInstructions?: string): string {
  const workspace = job.launchSpec?.v === 2 && job.launchSpec.workspace.kind === 'scratch'
    ? 'in T3’s internal scratch workspace'
    : job.workspaceKind === 'root'
      ? 'in the project’s own folder'
      : `in a fresh worktree on branch ${job.branch}`;
  // With the 20,000-character task bound and 4,000-character config bound, including the footer stays below T3’s 120,000 limit.
  const prefix = standingInstructions === undefined ? '' : `<operator-standing-instructions>\n${standingInstructions}\n</operator-standing-instructions>\n\n`;
  return `${prefix}${job.task}\n\n---\nStarted through t3-fleet-gateway as job ${job.id}, ${workspace}.`;
}

/**
 * Where a launch puts the thread: a fresh worktree on a branch of the project (from the local base, or from the freshly
 * fetched remote base), the project's own folder, or T3's own scratch workspace.
 */
type Workspace = { kind: 'scratch' } | { kind: 'root' } | { kind: 'worktree'; baseRef: string; branch: string; startFromOrigin: boolean };

function workspaceStrategy(workspace: Exclude<Workspace, { kind: 'scratch' }>): LaunchWorkspaceStrategy {
  return workspace.kind === 'root'
    ? { type: 'root' }
    : { type: 'worktree', baseRef: workspace.baseRef, branch: workspace.branch, startFromOrigin: workspace.startFromOrigin };
}

/**
 * What one launch sends: from the project config (alias-only jobs) or from the job's recorded launch spec. For a scratch
 * launch `projectId` is the configured pin: it is checked against the host's projects before the launch and names the project
 * a lost launch is looked for in, but it is not sent (T3 files a scratch thread under its own scratch project).
 */
interface LaunchPlan {
  projectId: string;
  workspace: Workspace;
  modelSelection: Record<string, unknown> | undefined;
  /** The configured alias whose cached project id a project error should drop, if any. */
  alias: string | null;
  /** What the dispatcher resolved for a version 3 job (see workspace.ts); the ledger claims the job with it. */
  resolved?: ResolvedWorkspace;
  /** Added to T3's refusal when it asks for a model this launch did not send. */
  missingModelHint: string;
}

function planFromConfig(config: GatewayConfig, project: ProjectConfig, projectId: string, branch: string): LaunchPlan {
  const model = configuredModel(config, project);
  return {
    projectId,
    workspace: { kind: 'worktree', baseRef: project.baseRef, branch, startFromOrigin: false },
    modelSelection: model?.selection,
    alias: project.alias,
    missingModelHint: model
      ? ''
      : ` If T3 asks for a model: the operator sets modelSelection for project "${project.alias}" or defaultModelSelection for host "${project.host}" in the gateway config.`,
  };
}

function planFromSpec(spec: LaunchSpec, hostId: string, projectId: string, workspace: Workspace): LaunchPlan {
  return {
    projectId,
    workspace,
    modelSelection: spec.model.selection ?? undefined,
    alias: spec.alias,
    missingModelHint: spec.model.selection
      ? ''
      : ` If T3 asks for a model: pass modelSelection to work_start (fleet_models lists the choices), or the operator sets defaultModelSelection for host "${hostId}".`,
  };
}

interface HostState {
  unreachableSince: number | null;
  failures: number;
  nextAttemptAt: number;
  /** The failure that marked the host unreachable most recently; null while it answers. */
  errorCode: string | null;
}

/** What the engine holds in memory, for the operator dashboard. Never stored: a restart starts empty. */
export interface EngineStatus {
  /** Ticking on its timer (serve); false when stopped or driven by hand (tests). */
  running: boolean;
  intervalMs: number;
  /** When the last tick finished, or null if none has since the process started. */
  lastTickAt: number | null;
  /** Hosts the engine failed to reach while following their jobs; hosts without open jobs are never contacted by it. */
  hosts: { hostId: string; unreachableSince: number; failures: number; nextAttemptAt: number; errorCode: string | null }[];
}

export interface JobEngineOptions {
  config: GatewayConfig;
  store: JobStore;
  registry: HostRegistry;
  catalog: CatalogService;
  clock: Clock;
  logger: Logger;
  /** Time between ticks. Defaults to `watcher.pollSeconds`. */
  intervalMs?: number;
  /** How long to wait for `t3_thread_launch`. Defaults to 60 seconds. */
  launchTimeoutMs?: number;
}

/**
 * The background half of the job layer. Each tick, per host: reconcile launches whose outcome is
 * unknown, watch jobs that have a thread, then dispatch queued jobs into free slots. Ticks never
 * overlap. Hosts that cannot be reached are backed off and their jobs keep their state. Nothing is
 * kept only in memory except backoff, the reconciliation clock and idle poll times, which restart
 * conservatively.
 */
export class JobEngine {
  readonly #options: JobEngineOptions;
  readonly #intervalMs: number;
  readonly #launchTimeoutMs: number;
  readonly #hosts = new Map<string, HostState>();
  readonly #projectIds = new Map<string, string>();
  /** Jobs this process is launching right now; any other `dispatching` job is stale. */
  readonly #inFlight = new Set<string>();
  /** When reconciliation first failed to find a job's thread while its host was reachable. */
  readonly #unconfirmedSince = new Map<string, { hostId: string; since: number }>();
  readonly #prAttempted = new Map<string, number>();
  readonly #lastPolled = new Map<string, number>();
  /** Aborted when the engine stops: kills a workspace probe that is still running. */
  readonly #shutdown = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #current: Promise<void> = Promise.resolve();
  #next: Promise<void> | undefined;
  #stopped = false;
  #lastTickAt: number | null = null;

  constructor(options: JobEngineOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? options.config.watcher.pollSeconds * SECOND;
    this.#launchTimeoutMs = options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
  }

  /** Tick now and then every interval. */
  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    void this.tick();
  }

  /** Ask for a tick soon (after a new job or an agent action). No-op unless started. */
  wake(): void {
    if (this.#timer && !this.#stopped) void this.tick();
  }

  /** Stop ticking and wait for the tick in progress. All job state is already in the database. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#shutdown.abort();
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#current;
  }

  /** Run one tick, or join the one already queued. Ticks run one at a time; tests call this directly. */
  tick(): Promise<void> {
    if (this.#next) return this.#next;
    const next = this.#current.then(async () => {
      this.#next = undefined;
      if (this.#stopped) return;
      await Promise.all(this.#options.config.hosts.map((host) => this.#tickHost(host)));
      this.#forgetFinished();
      this.#lastTickAt = this.#options.clock();
    });
    this.#next = next;
    this.#current = next.catch((error: unknown) => this.#options.logger.error('jobs.tick_failed', { errorCode: describeError(error).code }));
    return next;
  }

  status(): EngineStatus {
    const hosts = [...this.#hosts].flatMap(([hostId, state]) =>
      state.unreachableSince === null
        ? []
        : [{ hostId, unreachableSince: state.unreachableSince, failures: state.failures, nextAttemptAt: state.nextAttemptAt, errorCode: state.errorCode }]);
    return { running: this.#timer !== undefined && !this.#stopped, intervalMs: this.#intervalMs, lastTickAt: this.#lastTickAt, hosts };
  }

  /** Drop the in-memory poll times and reconciliation windows of jobs that have finished. */
  #forgetFinished(): void {
    if (this.#prAttempted.size === 0 && this.#lastPolled.size === 0 && this.#unconfirmedSince.size === 0) return;
    const open = this.#options.store.openJobIds();
    for (const jobId of this.#prAttempted.keys()) if (!open.has(jobId)) this.#prAttempted.delete(jobId);
    for (const jobId of this.#lastPolled.keys()) if (!open.has(jobId)) this.#lastPolled.delete(jobId);
    for (const jobId of this.#unconfirmedSince.keys()) if (!open.has(jobId)) this.#unconfirmedSince.delete(jobId);
  }

  async #tickHost(host: HostConfig): Promise<void> {
    const { store, clock, logger } = this.#options;
    const state = this.#hostState(host.id);
    if (state.nextAttemptAt > clock() || !store.hasOpenJobs(host.id)) return;
    const client = this.#options.registry.client(host.id);
    try {
      if (state.unreachableSince !== null) await client.environmentRead();
      // A failure that concerns one job is recorded on that job inside each step. Anything else that
      // escapes a step is logged and the next step still runs, so queued work is still dispatched.
      const steps = [
        ['reconcile', () => this.#reconcile(host)],
        ['watch', () => this.#watch(host)],
        ['release', () => this.#releaseStaleHolds(host)],
        ['dispatch', () => this.#dispatch(host)],
      ] as const;
      for (const [step, run] of steps) {
        try {
          await run();
        } catch (error) {
          if (isHostFailure(error)) throw error;
          logger.error('jobs.host_tick_failed', { hostId: host.id, step, errorCode: describeError(error).code });
        }
      }
      this.#markReachable(host.id);
    } catch (error) {
      if (isHostFailure(error)) this.#markUnreachable(host.id, error);
      else logger.error('jobs.host_tick_failed', { hostId: host.id, errorCode: describeError(error).code });
    }
  }

  /**
   * Record a failure that concerns one job only (a T3 tool error, an answer in an unexpected shape):
   * the job keeps its state, carries the error, and is tried again next tick. Host failures propagate.
   */
  #jobFailed(job: Job, error: unknown, event: string): void {
    if (isHostFailure(error)) throw error;
    const described = describeError(error);
    const code = error instanceof T3ToolError ? error.t3Code : described.code;
    this.#options.store.update(job.id, { lastErrorCode: code, lastErrorMessage: described.message });
    this.#options.logger.warn(event, { jobId: job.id, hostId: job.hostId, errorCode: code });
  }

  /**
   * Fill free slots with queued jobs, oldest first. A job that cannot launch now takes no slot and does not hold up the ones
   * behind it: it failed, it waits for its probe's next attempt, or it waits for the job that holds its folder (the ledger
   * leaves such jobs out of the window). One tick looks at a bounded number of jobs and runs a bounded number of probes.
   */
  async #dispatch(host: HostConfig): Promise<void> {
    const { store, clock } = this.#options;
    const free = host.maxConcurrentJobs - store.slotHolders(host.id);
    if (free <= 0) return;
    const budget = { probes: MAX_PROBES_PER_TICK };
    const tried = new Set<string>();
    let launched = 0;
    let checked = false;
    for (let round = 0; round < DISPATCH_ROUNDS && launched < free && budget.probes > 0; round++) {
      const queued = this.#queuedWithReadablePlans(host, free - launched + DISPATCH_SLACK).filter((job) => !tried.has(job.id));
      if (queued.length === 0) return;
      // A cheap read first: a dead connection (for example after T3 restarted) fails here, where a
      // retry is safe, instead of making the launch itself ambiguous.
      if (!checked) await this.#options.registry.client(host.id).environmentRead();
      checked = true;
      for (const job of queued) {
        if (launched >= free || budget.probes <= 0 || this.#shutdown.signal.aborted) return;
        tried.add(job.id);
        const plan = job.launchSpec ? await this.#planFromSpec(host, job, job.launchSpec, budget) : await this.#planFromConfig(host, job);
        if (!plan) continue;
        const access = expandProjectAccess(store.projectAccess(job.clientId), this.#options.config);
        if (!allowsProject(access, job.hostId, job.projectAlias, plan.projectId)) {
          this.#failQueued(job, 'insufficient_scope', 'The client is no longer approved for this project.');
          continue;
        }
        const changes = { t3ProjectId: plan.projectId, dispatchStartedAt: clock() };
        // A resolved workspace is claimed with the ledger (which also takes a root job's folder, or refuses it); the rest transition as before.
        const claim = plan.resolved
          ? store.dispatch(job.id, plan.resolved, changes)
          : (() => {
              const dispatching = store.transition(job.id, { from: ['queued'], to: 'dispatching', changes });
              return dispatching ? { kind: 'claimed' as const, job: dispatching } : { kind: 'gone' as const };
            })();
        if (claim.kind !== 'claimed') continue;
        launched++;
        if (!(await this.#launch(claim.job, plan))) return;
      }
    }
  }

  /**
   * The oldest queued jobs, up to `limit`, that can be launched. A job whose stored launch plan cannot be read fails here,
   * from the ledger alone (a host that is down does not hold it): it is never launched, not even from the configuration as
   * an alias job, which is what having no plan means. It takes no place in the window, so the jobs behind it still dispatch
   * in this tick.
   */
  #queuedWithReadablePlans(host: HostConfig, limit: number): Job[] {
    const { store, clock } = this.#options;
    let queued: Job[] = [];
    for (let round = 0; round < MAX_UNREADABLE_ROUNDS; round++) {
      queued = store.queued(host.id, limit, { now: clock() });
      const unreadable = queued.filter((job) => job.launchSpecUnreadable);
      if (unreadable.length === 0) break;
      for (const job of unreadable) this.#failQueued(job, 'database_error', UNREADABLE_PLAN);
    }
    return queued.filter((job) => !job.launchSpecUnreadable);
  }

  /** The launch of an alias-only job: its project resolved on the host now. Undefined when the job failed instead. */
  async #planFromConfig(host: HostConfig, job: Job): Promise<LaunchPlan | undefined> {
    const { config } = this.#options;
    const project = config.projects.find((candidate) => candidate.alias === job.projectAlias);
    if (!project) {
      this.#failQueued(job, 'project_not_configured', `Project "${job.projectAlias}" is no longer configured.`);
      return undefined;
    }
    if (project.host !== job.hostId || project.workspaceMode !== 'worktree') {
      this.#failQueued(job, 'launch_policy_changed', 'The configured project host or workspace mode changed. Start the work again under the current policy.');
      return undefined;
    }
    if (!runtimeModeFits(job.runtimeMode, host, project.runtimeMode)) {
      this.#failQueued(job, 'launch_policy_changed', `Not launched: the job's runtime mode exceeds the current policy of project "${project.alias}" or host ${host.id}. Start the work again under the current policy.`);
      return undefined;
    }
    try {
      return planFromConfig(config, project, await this.#projectId(project), job.branch);
    } catch (error) {
      if (isHostFailure(error)) throw error;
      this.#failQueued(job, 'project_not_found', describeError(error).message);
      return undefined;
    }
  }

  /**
   * The launch of a job with a recorded spec. The host's project list and, for an explicit model
   * selection, its capabilities are read now (never from the browse cache): a host that cannot answer
   * leaves the job queued (the host failure propagates); a project that is gone, that a configured alias
   * other than the recorded one now governs (a title renamed since), that no longer accepts work, or a
   * selection the host no longer advertises fails the job before anything is launched. A version 3 spec, last, has its
   * workspace resolved by the host's probe (`#resolveWorkspace`), which may leave the job queued for another try.
   */
  async #planFromSpec(host: HostConfig, job: Job, spec: LaunchSpec, budget: { probes: number }): Promise<LaunchPlan | undefined> {
    const { config, catalog } = this.#options;
    // A host default needs no discovery: only the binding the job was started under must still hold.
    if (spec.v !== 1 && (spec.hostId !== job.hostId || (spec.v === 2 && spec.defaultProject !== null && host.defaultProject !== spec.defaultProject))) {
      this.#failQueued(job, 'launch_policy_changed', 'The recorded host or default scratch binding changed. Start the work again under the current policy.');
      return undefined;
    }
    if (!runtimeModeAllowed(spec.runtimeMode, host.access)) {
      this.#failQueued(job, 'launch_policy_changed', 'The recorded runtime mode exceeds the host access ceiling.');
      return undefined;
    }
    if (spec.alias !== null && !config.projects.some((candidate) => candidate.alias === spec.alias)) {
      this.#failQueued(job, 'project_not_configured', `Project "${spec.alias}" is no longer configured.`);
      return undefined;
    }
    let projectId = spec.projectId;
    try {
      const projects = (await catalog.projects(job.hostId, { refresh: true })).value;
      const mappings = mapProjects(config, job.hostId, projects);
      const alias = spec.alias === null ? undefined : config.projects.find((candidate) => candidate.alias === spec.alias);
      // An alias-only request was recorded without reading T3: its project is found now, through the alias.
      if (projectId === null) projectId = [...mappings.values()].find((candidate) => alias && candidate.aliases.includes(alias))?.project.id ?? null;
      const mapping = projectId === null ? undefined : mappings.get(projectId);
      if (projectId === null || !mapping) {
        this.#failQueued(job, 'project_not_found', projectId === null ? `Project "${spec.alias}": host ${job.hostId} has no matching T3 project.` : `Host ${job.hostId} no longer has T3 project ${projectId}.`);
        return undefined;
      }
      let changed: string | undefined;
      if (alias) {
        // The agent named the alias: it must still resolve to the recorded project (a title may have moved) and accept work.
        if (!mapping.aliases.includes(alias)) changed = `project "${alias.alias}" no longer resolves to T3 project ${projectId} on host ${job.hostId}`;
        else if (alias.workspaceMode !== (spec.v === 2 ? 'scratch' : 'worktree')) changed = `project "${alias.alias}" changed workspace mode`;
        else if (spec.v !== 1 && alias.runtimeMode !== spec.runtimeMode) changed = `project "${alias.alias}" changed runtime mode`;
        else if (!runtimeModeFits(job.runtimeMode, host, alias.runtimeMode)) changed = `the job's runtime mode exceeds the current policy of project "${alias.alias}"`;
        else if (!alias.allowWorkStart) changed = `project "${alias.alias}" no longer accepts work_start`;
      } else {
        const policy = launchPolicy(host, mapping);
        if (policy.kind !== 'discovered') {
          const aliases = policy.kind === 'alias' ? [policy.project.alias] : policy.aliases;
          changed = `T3 project ${projectId} on host ${job.hostId} is now configured under ${aliases.length === 1 ? 'alias' : 'aliases'} ${aliases.join(', ')}`;
        } else if (!host.discovery.enabled || !host.discovery.allowWorkStart) {
          changed = `host ${job.hostId} no longer accepts work_start into T3 projects without a configured alias`;
        } else if (!runtimeModeFits(job.runtimeMode, host, host.discovery.runtimeMode)) {
          changed = `the job's runtime mode exceeds the current discovery policy of host ${job.hostId}`;
        }
      }
      if (changed) {
        this.#failQueued(job, 'launch_policy_changed', `Not launched: ${changed}. Start the work again under the current policy (fleet_projects shows it).`);
        return undefined;
      }
    } catch (error) {
      if (isHostFailure(error)) throw error;
      const described = describeError(error);
      this.#failQueued(job, described.code, `The project list of host ${job.hostId} could not be read before the launch: ${described.message}`);
      return undefined;
    }
    if (spec.model.source === 'explicit' && spec.model.selection) {
      try {
        const providers = (await catalog.models(job.hostId, { refresh: true, search: spec.model.selection.model as string })).value;
        validateSelection(job.hostId, providers, spec.model.selection as unknown as ModelSelection);
      } catch (error) {
        if (isHostFailure(error)) throw error;
        const described = describeError(error);
        this.#failQueued(job, 'model_selection_invalid', `The job's model selection is no longer available on host ${job.hostId}: ${described.message}`);
        return undefined;
      }
    }
    if (spec.v === 1) return planFromSpec(spec, job.hostId, projectId, { kind: 'worktree', baseRef: spec.baseRef, branch: job.branch, startFromOrigin: false });
    if (spec.v === 2) return planFromSpec(spec, job.hostId, projectId, { kind: 'scratch' });
    const resolved = await this.#resolveWorkspace(host, job, projectId, spec.workspace, budget);
    if (!resolved) return undefined;
    const workspace: Workspace = resolved.kind === 'root' ? { kind: 'root' } : { kind: 'worktree', baseRef: resolved.baseRef, branch: job.branch, startFromOrigin: resolved.startFromOrigin };
    return { ...planFromSpec(spec, job.hostId, projectId, workspace), resolved };
  }

  /**
   * Decide a version 3 job's workspace now, from the folder the project has on its host: the project's `workspaceRoot` is read
   * from T3 (never stored) and the host's probe inspects it. Undefined means the job did not get one: it failed, it waits for
   * the probe's next attempt, or the gateway is stopping. A T3 host failure propagates (the job stays queued and the host backs off);
   * a probe that cannot reach its host costs that job one of a few attempts and nothing else.
   */
  async #resolveWorkspace(
    host: HostConfig,
    job: Job,
    projectId: string,
    intent: WorkspaceIntent,
    budget: { probes: number },
  ): Promise<ResolvedWorkspace | undefined> {
    const { registry, store, clock } = this.#options;
    const command = host.workspaceProbeCommand;
    if (!command) {
      this.#failQueued(job, 'launch_policy_changed', `Host ${host.id} no longer configures a workspaceProbeCommand. Start the work again under the current policy.`);
      return undefined;
    }
    let root: string | null | undefined;
    try {
      root = (await registry.client(host.id).listProjects()).find((candidate) => candidate.id === projectId)?.workspaceRoot;
    } catch (error) {
      if (isHostFailure(error)) throw error;
      this.#failQueued(job, 'workspace_probe_failed', `The project list of host ${host.id} could not be read to find the project's folder.`);
      return undefined;
    }
    if (typeof root !== 'string' || !root.startsWith('/')) {
      this.#failQueued(job, 'workspace_probe_failed', `T3 reports no usable folder for project ${projectId}, so its workspace cannot be chosen.`);
      return undefined;
    }
    budget.probes--;
    try {
      const inspection = await runWorkspaceProbe(command, probeRequest(intent, root), { signal: this.#shutdown.signal });
      return resolveWorkspace(host.id, intent, inspection);
    } catch (error) {
      if (this.#shutdown.signal.aborted) return undefined;
      const described = describeError(error);
      if (described.code === 'workspace_probe_unavailable' && job.probeAttempts + 1 < MAX_PROBE_ATTEMPTS) {
        const attempts = job.probeAttempts + 1;
        store.update(job.id, {
          probeAttempts: attempts,
          probeRetryAt: clock() + this.#intervalMs * 2 ** (attempts - 1),
          lastErrorCode: described.code,
          lastErrorMessage: described.message,
        });
        return undefined;
      }
      this.#failQueued(job, described.code === 'workspace_probe_unavailable' ? described.code : 'workspace_probe_failed', described.message);
      return undefined;
    }
  }

  /** Give up the folders of idle jobs whose resume was never seen to start anything (see `JobStore.releaseStaleHolds`). */
  #releaseStaleHolds(host: HostConfig): void {
    const { store, clock, logger } = this.#options;
    const released = store.releaseStaleHolds(host.id, clock(), RESUME_GRACE_MS);
    if (released > 0) logger.info('jobs.workspace_root_released', { hostId: host.id, count: released });
  }

  #failQueued(job: Job, code: string, message: string): void {
    const failed = this.#options.store.transition(job.id, {
      from: ['queued'],
      to: 'failed',
      changes: { lastErrorCode: code, lastErrorMessage: message },
      detail: { reason: code, code },
    });
    if (failed) this.#options.registry.signals(job.hostId).recordCode('dispatch', code);
  }

  /** Launch one job's thread. Returns false when no further job should be launched this tick. */
  async #launch(job: Job, plan: LaunchPlan): Promise<boolean> {
    const { store, registry } = this.#options;
    this.#inFlight.add(job.id);
    try {
      let launched: LaunchResult;
      let attachments;
      try { attachments = store.launchAttachments(job.id); }
      catch {
        store.transition(job.id, { from: ['dispatching'], to: 'failed', changes: {
          lastErrorCode: 'database_error', lastErrorMessage: "This job's stored attachments could not be read. Start the work again.",
        }, detail: { reason: 'database_error', code: 'database_error' } });
        store.clearLaunchAttachments(job.id);
        return true;
      }
      let uploaded;
      try { uploaded = attachments.length ? await registry.client(job.hostId).uploadAttachments(attachments) : undefined; }
      catch (error) {
        // Uploading alone cannot create a thread, even if the upload response is lost.
        store.transition(job.id, { from: ['dispatching'], to: isHostFailure(error) ? 'queued' : 'failed',
          changes: { dispatchStartedAt: null, ...(isHostFailure(error) ? {} : {
            lastErrorCode: 'invalid_argument', lastErrorMessage: "T3 could not accept this job's attachments.",
          }) }, detail: { reason: 'attachment_upload_failed' } });
        store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', detail: { reason: 'cancelled_before_launch' } });
        if (isHostFailure(error)) throw error;
        return true;
      }
      if (store.require(job.id).state === 'cancel_requested') {
        store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', detail: { reason: 'cancelled_before_launch' } });
        return true;
      }
      try {
        launched = await registry.client(job.hostId).launchThread(
          {
            clientRequestId: `t3fg-launch-${job.id}`,
            title: job.title,
            runtimeMode: job.runtimeMode as RuntimeMode,
            ...(plan.modelSelection ? { modelSelection: plan.modelSelection } : {}),
            message: launchMessage(job, this.#options.config.standingInstructions),
            ...(uploaded ? { attachments: uploaded } : {}),
            ...(plan.workspace.kind === 'scratch'
              ? { scratch: true as const }
              : { projectId: plan.projectId, workspaceStrategy: workspaceStrategy(plan.workspace) }),
          },
          { timeoutMs: this.#launchTimeoutMs },
        );
      } catch (error) {
        if (error instanceof T3ToolError) return await this.#launchRefused(job, plan,
          uploaded ? new T3ToolError(error.tool, error.t3Code, 'T3 could not accept the attached files.') : error);
        if (error instanceof T3TransportError && error.delivery === 'not_delivered') {
          store.transition(job.id, { from: ['dispatching'], to: 'queued', changes: { dispatchStartedAt: null }, detail: { reason: 'host_unreachable', code: error.code } });
          store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', detail: { reason: 'cancelled_before_launch' } });
          throw error;
        }
        const described = describeError(error);
        store.transition(job.id, {
          from: ['dispatching'],
          to: 'unknown',
          changes: { lastErrorCode: described.code, lastErrorMessage: described.message },
          detail: { reason: 'launch_outcome_unknown', code: described.code },
        });
        // T3 prepares the worktree before answering, so a slow launch says nothing about the host (the
        // next tick's probe does). The job is reconciled like any unknown launch; launch no more now.
        if (error instanceof T3TransportError && error.code === 't3_timeout') return false;
        if (isHostFailure(error)) throw error;
        return true;
      }
      // The thread exists whichever project T3 filed it under, so the job follows it; only the warning says the pin was wrong.
      if (plan.workspace.kind === 'scratch' && launched.projectId !== plan.projectId) {
        this.#options.logger.warn('job.scratch_project_mismatch', { jobId: job.id, hostId: job.hostId });
      }
      const thread = { threadId: launched.threadId, threadTitle: job.title, lastRunId: launched.runId, threadLink: threadLinkTarget(launched.link) };
      await this.#attach(job.id, thread, 'launched', null);
      return true;
    } finally {
      if (!['queued', 'dispatching'].includes(store.require(job.id).state)) store.clearLaunchAttachments(job.id);
      this.#inFlight.delete(job.id);
    }
  }

  /**
   * T3 answered the launch with an error. Some refusals happen before anything is created; after any
   * other, T3 may have created the thread (its own guidance is to look before retrying), so the
   * marker is looked up once: found, the job continues on that thread; not found, it fails with
   * T3's code. If the lookup fails in any way, the job is unknown and reconciliation takes over:
   * failing it would free the slot while a thread may exist.
   */
  async #launchRefused(job: Job, plan: LaunchPlan, error: T3ToolError): Promise<boolean> {
    const { store } = this.#options;
    if (plan.alias !== null && /project/.test(error.t3Code)) this.#projectIds.delete(plan.alias);
    // T3 refuses a launch without a model when the project has no default (T3's message says so).
    const hint = error.t3Code === 'invalid_request' ? plan.missingModelHint : '';
    const failure = { lastErrorCode: error.t3Code, lastErrorMessage: `${error.message}${hint}` };
    if (!REFUSED_BEFORE_CREATION.has(error.t3Code)) {
      let found: FoundThread | undefined;
      try {
        found = await this.#findThread(job.hostId, plan.projectId, job.id);
      } catch (lookupError) {
        store.transition(job.id, { from: ['dispatching'], to: 'unknown', changes: failure, detail: { reason: 'launch_outcome_unknown', code: error.t3Code } });
        if (isHostFailure(lookupError)) throw lookupError;
        return true;
      }
      if (found) {
        await this.#attach(job.id, found, 'reconciled', error.t3Code);
        return true;
      }
    }
    store.transition(job.id, { from: ['dispatching'], to: 'failed', changes: failure, detail: { reason: 'launch_rejected', code: error.t3Code } });
    store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', changes: failure, detail: { reason: 'launch_rejected', code: error.t3Code } });
    return true;
  }


  /**
   * Resolve launches whose outcome is unknown, never by launching again: look for the job marker in
   * the project's threads. Found: attach the thread. Not found for `reconcileWindowMinutes` while
   * the host answers: the launch did not happen, so the job fails with `launch_not_confirmed`.
   */
  async #reconcile(host: HostConfig): Promise<void> {
    const { store, config } = this.#options;
    for (const job of store.onHost(host.id, ['dispatching'])) {
      if (this.#inFlight.has(job.id)) continue;
      store.transition(job.id, { from: ['dispatching'], to: 'unknown', detail: { reason: 'dispatch_interrupted' } });
    }
    const windowMs = config.watcher.reconcileWindowMinutes * MINUTE;
    // cancel_requested jobs without a thread were cancelled while launching or unconfirmed.
    for (const job of store.onHost(host.id, ['unknown', 'cancel_requested'])) {
      if (job.threadId !== null || job.t3ProjectId === null || this.#inFlight.has(job.id)) continue;
      try {
        await this.#reconcileJob(job, job.t3ProjectId, windowMs);
      } catch (error) {
        // A lookup that failed is not a miss: the window neither starts nor advances.
        this.#jobFailed(job, error, 'jobs.reconcile_failed');
      }
    }
  }

  async #reconcileJob(job: Job, projectId: string, windowMs: number): Promise<void> {
    const { store, clock, config } = this.#options;
    const found = await this.#findThread(job.hostId, projectId, job.id);
    if (found) {
      this.#unconfirmedSince.delete(job.id);
      // The launch's own error; lastError may since hold a failed lookup's.
      const launchEvent = store.recentEvents(job.id, 20).findLast((event) => event.detail.reason === 'launch_outcome_unknown');
      const launchCode = launchEvent?.detail.code ?? null;
      await this.#attach(job.id, found, 'reconciled', launchCode);
      return;
    }
    const since = this.#unconfirmedSince.get(job.id)?.since ?? clock();
    this.#unconfirmedSince.set(job.id, { hostId: job.hostId, since });
    if (clock() - since < windowMs) return;
    this.#unconfirmedSince.delete(job.id);
    const changes = {
      lastErrorCode: 'launch_not_confirmed',
      lastErrorMessage: `No T3 thread titled with ${jobMarker(job.id)} appeared within ${config.watcher.reconcileWindowMinutes} minutes, so the launch did not happen. Start a new job if the work is still needed.`,
    };
    const detail = { reason: 'launch_not_confirmed', code: 'launch_not_confirmed' };
    store.transition(job.id, { from: ['unknown'], to: 'failed', changes, detail });
    store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', changes, detail });
  }

  /**
   * The thread carrying the job's marker: by title in the project's unsettled, then settled threads,
   * then by search. A search match T3 refuses to read is skipped: one unreadable thread must not stall
   * reconciliation, and the job's own thread is found by title.
   */
  async #findThread(hostId: string, projectId: string, jobId: string): Promise<FoundThread | undefined> {
    const client = this.#options.registry.client(hostId);
    const marker = jobMarker(jobId);
    // The marker ends the title; one merely mentioned elsewhere in a title is someone else's thread.
    const carriesMarker = (title: string) => title.trim().endsWith(marker);
    // T3 lists unsettled threads unless asked for settled ones, and a job's thread may be settled already.
    for (const settled of [false, true]) {
      const listed = await client.listThreads({ projectId, titleContains: marker, limit: 10, ...(settled ? { settled } : {}) });
      const byTitle = listed.threads.filter((thread) => carriesMarker(thread.title)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (byTitle) return foundThread(byTitle);
    }
    const searched = await client.searchThreads({ projectId, query: jobId, limit: 20 });
    for (const threadId of new Set(searched.matches.map((match) => match.threadId))) {
      let thread: ThreadRead['thread'];
      try {
        ({ thread } = await client.readThread({ threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 }));
      } catch (error) {
        if (error instanceof T3ToolError) continue;
        throw error;
      }
      if (carriesMarker(thread.title)) return foundThread(thread);
    }
    return undefined;
  }


  /** Observe every job that has a thread and is not finished; idle jobs less often. */
  async #watch(host: HostConfig): Promise<void> {
    const prBudget = { remaining: 4 };
    const { store, clock } = this.#options;
    // Oldest optional lookup first: the per-tick budget must not starve later idle jobs.
    const jobs = store.onHost(host.id, ['running', 'needs_input', 'cancel_requested', 'idle']);
    jobs.sort((a, b) => (this.#prAttempted.get(a.id) ?? a.pullRequestsCheckedAt ?? -Infinity) -
      (this.#prAttempted.get(b.id) ?? b.pullRequestsCheckedAt ?? -Infinity));
    for (const job of jobs) {
      if (job.threadId === null) continue;
      if (job.state === 'idle' && clock() - (this.#lastPolled.get(job.id) ?? 0) < IDLE_POLL_MS) continue;
      try {
        await this.#observeJob(job, job.threadId, prBudget);
      } catch (error) {
        this.#jobFailed(job, error, 'jobs.watch_failed');
      }
      this.#lastPolled.set(job.id, clock());
    }
  }

  async #observeJob(job: Job, threadId: string, prBudget: { remaining: number }): Promise<void> {
    const { store, registry, logger, clock } = this.#options;
    const client = registry.client(job.hostId);
    let read: ThreadRead;
    let questions: string[];
    let activity: ActivityRead;
    try {
      // Messages first: a subagent item comes before the reply that mentions it, so the activity read
      // after it sees the delegated work behind any finished turn the messages read saw.
      read = await this.#readNew(job, threadId);
      questions = await client.listPendingRequests(threadId);
      activity = await this.#readActivity(job, threadId);
    } catch (error) {
      if (!(error instanceof T3ToolError)) throw error;
      logger.warn('jobs.watch_failed', { jobId: job.id, hostId: job.hostId, errorCode: error.t3Code });
      if (/not_found/.test(error.t3Code)) {
        store.transition(job.id, {
          from: [job.state],
          to: job.state === 'cancel_requested' ? 'cancelled' : 'failed',
          changes: { lastErrorCode: 'thread_missing', lastErrorMessage: `T3 no longer has the job's thread (${error.t3Code}).` },
          detail: { reason: 'thread_missing', code: error.t3Code },
        });
      } else {
        store.update(job.id, { lastErrorCode: error.t3Code, lastErrorMessage: error.message });
      }
      return;
    }
    // Optional metadata must never change host health or suppress normal state observation.
    const prChanges: JobChanges = {};
    let prEvents: ReturnType<typeof pullRequestEvents> = [];
    const attempted = this.#prAttempted.get(job.id) ?? job.pullRequestsCheckedAt;
    if (prBudget.remaining > 0 && (attempted === null || clock() - attempted >= MINUTE)) {
      this.#prAttempted.set(job.id, clock());
      prBudget.remaining--;
      try {
        const value = Object.hasOwn(read.thread, 'pullRequests') ? read.thread.pullRequests
          : (await client.listThreadPullRequests(threadId)).pullRequests;
        // The tracked list (bounded), or null when the answer holds nothing readable: unknown, so the last snapshot and its freshness stay.
        const prs = readPullRequests(value);
        if (prs !== null) {
          prChanges.pullRequests = prs;
          prChanges.pullRequestsCheckedAt = clock();
          prEvents = pullRequestEvents(job.pullRequests, prs);
        }
      } catch { /* Missing tool, malformed output or transport error: retain the last known snapshot. */ }
    }
    const seen = observe(job, read, questions, activity);
    // A later turn may start and finish entirely between idle polls. A repeated failed snapshot
    // is not recovery, nor is metadata activity (PRs, settlement) on the same failed run.
    const recovered = job.lastErrorCode === 't3_run_failed' && !seen.errorCode &&
      (seen.state === 'running' || seen.state === 'needs_input' || seen.anotherTurnFinished);
    const recoveryEvents = recovered ? [{ type: 'job_recovered', detail: { reason: 'worker_resumed' } }] : [];
    // An idle job's delegated work ended (finished, failed or cancelled) and no turn followed: T3 starts
    // one by itself when a child finishes, but not always (a failed or cancelled child, say), and the job
    // would otherwise sit waiting with nothing to tell the agent.
    const hadDelegated = job.delegatedWork.length > 0 || job.delegatedUntracked > 0;
    const hasDelegated = seen.delegatedWork.length > 0 || seen.delegatedUntracked > 0;
    const delegatedEnded = job.state === 'idle' && seen.state === 'idle' && hadDelegated && !hasDelegated && !seen.anotherTurnFinished;
    const changes: JobChanges = {
      ...prChanges,
      pendingRequestIds: seen.pendingRequestIds,
      delegatedWork: seen.delegatedWork,
      delegatedUntracked: seen.delegatedUntracked,
      delegatedUntrackedRunId: seen.delegatedUntrackedRunId,
      ...(delegatedEnded ? { delegatedEndedAt: clock() } : hasDelegated || seen.anotherTurnFinished ? { delegatedEndedAt: null } : {}),
      readPosition: seen.readPosition,
      activityPosition: seen.activityPosition,
      latestActivityAt: seen.activityAt,
      lastRunId: seen.lastRunId,
      ...(seen.excerpt === undefined ? {} : { latestMessageExcerpt: seen.excerpt, latestMessageTruncated: seen.excerptTruncated ?? false }),
      ...(seen.link === undefined ? {} : { threadLink: seen.link }),
      ...(seen.errorCode
        ? { lastErrorCode: seen.errorCode, lastErrorMessage: 'The T3 run failed. Open the thread in T3 for details.' }
        : // A valid observation clears a prior shape error; a failed run clears only once a new turn runs.
          job.lastErrorCode === 't3_invalid_response' || recovered
          ? { lastErrorCode: null, lastErrorMessage: null }
          : {}),
    };
    // The original snapshot guards both paths: an agent action or another watcher that landed
    // while T3 was being read wins, even when it kept the same state. Row and event commit together.
    if (seen.state === job.state) {
      if (!store.transition(job.id, {
        from: [job.state], to: job.state, expected: job, changes,
        turnRunId: read.thread.activeRunId ?? read.thread.latestRunId,
        events: [
          ...prEvents,
          ...recoveryEvents,
          ...(seen.anotherTurnFinished ? [{ type: 'turn_finished', detail: { reason: seen.reason } }] : []),
          ...(delegatedEnded ? [{ type: 'delegated_work_ended', detail: { reason: 'no_turn_started' } }] : []),
        ],
      })) return;
      // Still running after a cancel: the interrupt may never have arrived, or a new run started
      // since (a queued follow-up, or someone in T3). Interrupt the run that is active now.
      if (job.state === 'cancel_requested') {
        await this.#interrupt(job.id, job.hostId, { threadId, runId: read.thread.activeRunId ?? read.thread.latestRunId }, registry);
      }
      return;
    }
    store.transition(job.id, {
      from: [job.state],
      to: seen.state,
      expected: job,
      turnRunId: read.thread.activeRunId ?? read.thread.latestRunId,
      changes,
      events: [...prEvents, ...recoveryEvents],
      detail: { reason: seen.reason, ...(seen.errorCode ? { code: seen.errorCode } : {}) },
    });
  }

  /** Read the thread's state and every message after the job's read position (messages view, bounded). */
  async #readNew(job: Job, threadId: string): Promise<ThreadRead> {
    const client = this.#options.registry.client(job.hostId);
    let afterPosition = job.readPosition;
    let read: ThreadRead | undefined;
    const items: ThreadRead['items'] = [];
    for (let page = 0; page < MAX_READ_PAGES; page++) {
      read = await client.readThread({
        threadId,
        view: 'messages',
        afterPosition,
        limit: READ_PAGE_SIZE,
        runLimit: RECENT_RUNS,
        maxCharsPerItem: EXCERPT_CHARS,
      });
      items.push(...read.items);
      if (!read.hasMore || read.nextPosition === null) break;
      afterPosition = read.nextPosition;
    }
    if (!read) throw new GatewayError('internal_error', 'No thread read');
    return { ...read, items, nextPosition: read.nextPosition ?? afterPosition };
  }

  /**
   * The activity view after the job's activity position, for delegated work, and the current version of
   * the tasks the job follows that it did not return. Every watched job reads it, launched ones too: a
   * worker the gateway launched can delegate as well. A standing job without an activity position
   * (adopted before the gateway kept one) is scanned as at adoption, from its read position.
   */
  async #readActivity(job: Job, threadId: string): Promise<ActivityRead> {
    const client = this.#options.registry.client(job.hostId);
    const activity =
      job.standing && job.activityPosition === null
        ? await scanActivity(client, threadId, job.readPosition)
        : await readActivity(client, threadId, job.activityPosition);
    return { ...activity, refreshed: await refreshDelegated(client, threadId, job.delegatedWork, activity.items) };
  }

  /**
   * Record the job's thread and move it to running. A job cancelled while its launch was in flight
   * or unconfirmed keeps cancel_requested, and its thread is interrupted now. A found thread on
   * which no run ever started never received the task: the job fails with `launch_not_started`
   * (`launchCode` is the launch's own error, if any), keeping the thread so it can be inspected.
   */
  async #attach(jobId: string, thread: FoundThread, via: 'launched' | 'reconciled', launchCode: string | null): Promise<void> {
    const { store, registry } = this.#options;
    const { threadLink, status, ...rest } = thread;
    if (status !== undefined && thread.lastRunId === null && !isActiveStatus(status)) {
      const changes = {
        ...rest,
        ...(threadLink ? { threadLink } : {}),
        lastErrorCode: 'launch_not_started',
        lastErrorMessage:
          `T3 created the job's thread but started no run on it${launchCode ? ` (the launch answered ${launchCode})` : ''}, ` +
          'so the task was never delivered. The thread is kept for inspection; start a new job if the work is still needed.',
      };
      const detail = { reason: 'launch_not_started', code: 'launch_not_started' };
      store.transition(jobId, { from: ['dispatching', 'unknown'], to: 'failed', changes, detail });
      store.transition(jobId, { from: ['cancel_requested'], to: 'cancelled', changes, detail });
      return;
    }
    registry.signals(store.require(jobId).hostId).record('dispatch');
    const changes = { pullRequests: [], ...rest, ...(threadLink ? { threadLink } : {}), lastErrorCode: null, lastErrorMessage: null };
    const gatewayTurn = via === 'launched' && thread.lastRunId !== null
      ? { runId: thread.lastRunId, clientId: store.require(jobId).clientId } : undefined;
    if (store.transition(jobId, { from: ['dispatching', 'unknown'], to: 'running', changes, gatewayTurn, detail: { reason: via } })) return;
    const job = store.get(jobId);
    if (job?.state !== 'cancel_requested') return;
    store.transition(jobId, { from: ['cancel_requested'], to: 'cancel_requested', changes, gatewayTurn });
    await this.#interrupt(jobId, job.hostId, { threadId: thread.threadId, runId: thread.lastRunId }, registry);
  }

  /** Deliver (or re-deliver) a cancel_requested job's interrupt for one run. T3 deduplicates repeats per run. */
  async #interrupt(jobId: string, hostId: string, thread: { threadId: string; runId: string | null }, registry: HostRegistry): Promise<void> {
    try {
      await deliverInterrupt(this.#options.store, registry.client(hostId), jobId, thread);
    } catch (error) {
      // Tried again on the next tick while the job is still cancel_requested and its thread active.
      if (isHostFailure(error)) throw error;
      this.#options.logger.warn('jobs.interrupt_failed', { jobId, hostId, errorCode: error instanceof T3ToolError ? error.t3Code : describeError(error).code });
    }
  }

  async #projectId(project: ProjectConfig): Promise<string> {
    const cached = this.#projectIds.get(project.alias);
    if (cached) return cached;
    const { id } = await resolveProject(this.#options.registry, project);
    this.#projectIds.set(project.alias, id);
    return id;
  }

  #hostState(hostId: string): HostState {
    let state = this.#hosts.get(hostId);
    if (!state) {
      state = { unreachableSince: null, failures: 0, nextAttemptAt: 0, errorCode: null };
      this.#hosts.set(hostId, state);
    }
    return state;
  }

  #markUnreachable(hostId: string, error: GatewayError): void {
    const { clock, store, logger } = this.#options;
    const state = this.#hostState(hostId);
    const now = clock();
    if (state.unreachableSince === null) {
      state.unreachableSince = now;
      logger.warn('jobs.host_unreachable', { hostId, errorCode: error.code });
    }
    state.failures += 1;
    state.errorCode = error.code;
    state.nextAttemptAt = now + Math.min(MAX_BACKOFF_MS, this.#intervalMs * 2 ** (state.failures - 1));
    store.markHostUnreachable(hostId, state.unreachableSince);
    // The not-found window only counts time the host was answering.
    for (const [jobId, entry] of this.#unconfirmedSince) if (entry.hostId === hostId) this.#unconfirmedSince.delete(jobId);
  }

  #markReachable(hostId: string): void {
    const state = this.#hostState(hostId);
    if (state.unreachableSince === null) return;
    this.#options.logger.info('jobs.host_reachable', { hostId, unreachableForMs: this.#options.clock() - state.unreachableSince });
    state.unreachableSince = null;
    state.failures = 0;
    state.nextAttemptAt = 0;
    state.errorCode = null;
    this.#options.store.clearHostUnreachable(hostId);
  }
}
