import { allowsProject, expandProjectAccess, projectDenied, type ProjectAccess } from '../oauth/projectAccess.ts';
import { isThreadId } from '../threadId.js';
import { configuredModel, RUNTIME_MODES, runtimeModeAllowed, type GatewayConfig, type HostConfig, type ProjectConfig } from '../config.ts';
import { sha256Hex } from '../crypto.ts';
import { describeError, GatewayError } from '../errors.ts';
import type { CatalogProject, CatalogService } from '../hosts/catalog.ts';
import { resolveProject } from '../hosts/projects.ts';
import type { HostRegistry } from '../hosts/registry.ts';
import type { Logger } from '../log.ts';
import { THREAD_READ_SCOPE, THREAD_CONTROL_SCOPE, permits, permittedHosts, type AccessLevel, type Scope } from '../oauth/scopes.ts';
import { T3TransportError, type T3Client } from '../t3/client.ts';
import { T3ToolError } from '../t3/results.ts';
import type { ThreadItem, ThreadRead } from '../t3/schemas.ts';
import { cleanThreadTitle, ThreadCatalog } from '../hosts/threads.ts';
import { HOUR, SECOND, type Clock } from '../time.ts';
import { attachmentHashes, validateAttachments, type AttachmentInput } from './attachments.ts';
import { scanActivity } from './activity.ts';
import { EXCERPT_CHARS, holdsReadPosition, isActiveStatus, isDelegatedWorkActive, observe, threadLinkTarget, type ActivityRead } from './derive.ts';
import { newJobId } from './ids.ts';
import { canonicalSelection, validateSelection, type LaunchSpec, type ModelSelection } from './launchSpec.ts';
import { workspaceIntent, type WorkspaceSelection } from './workspace.ts';
import { readWorkerMessages, type MessagePage, type MessageQuery } from './messages.ts';
import { cancelRequestId } from './interrupt.ts';
import { isTerminal, OPEN_STATES, type JobState } from './states.ts';
import { jobNotFound, type FeedEvent, type Job, type JobEvent, type JobScope, type JobStore } from './store.ts';
import { launchPolicy, mapProjects, parseProjectRef, projectRef } from './targets.ts';

/** Bounds on agent-supplied text. T3 accepts up to 120,000 characters per message. */
export const MAX_TASK_CHARS = 20_000;
export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_ANSWERS_CHARS = 16_000;
/** Idle and failed jobs stay in the feed's attention list this long after their last change. */
export const ATTENTION_RECENT_MS = 24 * HOUR;
const MAX_ATTENTION = 50;
export const MAX_QUESTION_READS = 5;
export const MAX_QUESTIONS = 50;
export const MAX_QUESTION_OPTIONS = 100;
/** Whole requests only: never truncate an option or required question into an unsafe partial answer. */
export const MAX_QUESTION_CHARS = 64_000;
const QUESTION_READ_TIMEOUT_MS = 5 * SECOND;
export const MAX_TITLE_CHARS = 80;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const TITLE_FROM_TASK_CHARS = 60;
/** Pages of 100 messages read to find the end of a thread being adopted (messages view). */
const MAX_ADOPT_PAGES = 1000;

/**
 * The agent calling a work tool. Its scopes decide which hosts it may read and operate on (oauth/scopes.ts):
 * a project or job on a host it may not read is reported exactly as one that does not exist.
 */
export interface Caller {
  clientId: string;
  scopes: readonly Scope[];
}

/**
 * What work_start was asked for: exactly one of `project` (a configured alias) or `target`. `target: { host }` names no
 * project and means the host's scratch alias (`defaultProject`); `target: { host, projectId }` names a T3 project from
 * fleet_projects on a host with discovery enabled.
 */
export interface StartInput {
  project?: string | undefined;
  target?: { host: string; projectId?: string | undefined } | undefined;
  /** An explicit provider, model and options from fleet_models; without it the configured defaults apply. */
  modelSelection?: ModelSelection | undefined;
  /**
   * Where a named project's work runs (workspace.ts). Only a host with a `workspaceProbeCommand` takes one; without it the
   * job is a worktree from the local base, as before. Not for scratch work.
   */
  workspace?: WorkspaceSelection | undefined;
  task: string;
  attachments?: AttachmentInput[] | undefined;
  requestId: string;
  title?: string | undefined;
}

export interface ContinueInput {
  jobId: string;
  message: string;
  attachments?: AttachmentInput[] | undefined;
  requestId: string;
}

export interface RespondInput {
  jobId: string;
  requestId: string;
  answers: Record<string, unknown>;
}

export interface ContinueResult {
  job: Job;
  /** How T3 took the message: started a new turn, steered or queued behind the active one. */
  delivery: string;
  /** True when this requestId had already been delivered and nothing was sent again. */
  replayed: boolean;
}

/**
 * `interrupt_requested` and `not_running` are for standing jobs, which work_cancel never closes: the
 * run is interrupted (the job becomes idle once T3 confirms) or nothing was running.
 */
export type CancelOutcome = 'cancelled' | 'cancel_requested' | 'already_finished' | 'interrupt_requested' | 'not_running';

export interface CancelResult {
  job: Job;
  outcome: CancelOutcome;
  /** T3 has the interrupt request (or no T3 call was needed). */
  delivered: boolean;
  /**
   * A standing job with nothing running whose thread T3 still lists questions for: interrupting does
   * not withdraw them, so they still need an answer (work_respond).
   */
  pendingQuestionIds?: string[];
}

export interface AdoptInput {
  project: string;
  threadId: string;
  /** Shown to agents instead of the thread's T3 title. */
  title?: string | undefined;
}

export interface Feed {
  events: FeedEvent[];
  nextCursor: number;
  hasMore: boolean;
  attention: Job[];
}

export interface JobServiceOptions {
  config: GatewayConfig;
  store: JobStore;
  registry: HostRegistry;
  catalog: CatalogService;
  clock: Clock;
  logger: Logger;
}

export interface PendingQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value: string | null }[];
  multiSelect: boolean | null;
  allowCustomAnswer: boolean | null;
  required: boolean | null;
}

export interface QuestionRequest {
  requestId: string;
  questions: PendingQuestion[] | null;
  questionsUnavailable: 'temporarily_unreadable' | 'read_limit' | 'too_large' | null;
}

export interface JobDetail {
  settled: boolean | null;
  settledAt: string | null;
  job: Job;
  recentEvents: JobEvent[];
  /** Questions the worker waits on. `questions` is null when they could not be read from T3. */
  pendingRequests: QuestionRequest[];
  /** Blocked with no answerable question: a permission approval only the operator can give in T3. */
  waitingForApproval: boolean;
}

/** The refusal of a resume while another job holds the folder this root job works in. */
function rootBusy(job: Job): GatewayError {
  return new GatewayError(
    'workspace_root_busy',
    `Job ${job.id} works in its project's own folder, which another gateway job on host ${job.hostId} holds right now. ` +
      'Nothing was sent. Try again when that job is finished or idle (work_list shows the jobs), or start the work in a fresh worktree.',
  );
}

/** Client imports/resumes need positive evidence that this is a normal, unarchived conversation. */
function requireExternalEligibility(thread: ThreadRead['thread']): void {
  const relation = thread.relationshipToParent;
  if (thread.archived === undefined || (relation !== null && relation !== 'fork' && relation !== 'subagent')) {
    throw new GatewayError('t3_invalid_response', 'T3 did not report known archive and lineage metadata. Client adoption/resume is unavailable for this thread.');
  }
  if (thread.archived || relation === 'subagent') {
    throw new GatewayError('job_state_conflict', 'Archived and delegated child threads cannot be adopted or resumed; use the parent thread in T3.');
  }
}

/** A stable hash of a tool's meaningful input, for request-id idempotency. */
export function inputHash(tool: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  return sha256Hex(JSON.stringify([tool, keys.map((key) => [key, input[key] ?? null])]));
}

/**
 * The idempotency hash of a work_start request. An alias-only request without a model selection hashes
 * exactly as before this build, so earlier request ids replay. A request with a target or a selection
 * hashes its canonical target and selection (option keys sorted), so reordered options match and a
 * changed target or selection under the same request id conflicts.
 */
export function startInputHash(input: StartInput): string {
  const attachments = validateAttachments(input.attachments);
  if (input.target === undefined && input.modelSelection === undefined && input.workspace === undefined && attachments.length === 0) {
    return inputHash('work_start', { project: input.project, task: input.task, title: input.title });
  }
  if (input.target === undefined && input.modelSelection === undefined && input.workspace === undefined) {
    return inputHash('work_start', { project: input.project, task: input.task, title: input.title, attachments: attachmentHashes(attachments) });
  }
  return inputHash('work_start', {
    ...(attachments.length ? { attachments: attachmentHashes(attachments) } : {}),
    project: input.project ?? null,
    target: input.target === undefined ? null : { host: input.target.host, ...(input.target.projectId === undefined ? {} : { projectId: input.target.projectId }) },
    modelSelection: input.modelSelection === undefined ? null : canonicalSelection(input.modelSelection),
    // Only a request that names a workspace hashes one: a request without it keeps the hash it always had.
    ...(input.workspace === undefined ? {} : { workspace: canonicalWorkspace(input.workspace) }),
    task: input.task,
    title: input.title,
  });
}

function canonicalWorkspace(workspace: WorkspaceSelection): Record<string, unknown> {
  return workspace.type !== 'worktree' ? { type: workspace.type } : {
    type: 'worktree',
    ...(workspace.baseRef === undefined ? {} : { baseRef: workspace.baseRef }),
    ...(workspace.startFromOrigin === undefined ? {} : { startFromOrigin: workspace.startFromOrigin }),
  };
}

/** Why work_start is refused in a project, and where to send the work instead. */
export function startDisabledMessage(alias: string, standing: Job[]): string {
  const where =
    standing.length === 0
      ? 'It has no standing job yet; ask the operator to adopt one (t3-fleet-gateway jobs adopt).'
      : `Send the work to its standing job with work_continue instead: ${standing.map((job) => `${job.id} ("${job.title}", ${job.state})`).join(', ')}. ` +
        'Follow it with work_feed and work_status.';
  return `Project "${alias}" does not accept work_start (allowWorkStart is false). ${where}`;
}

/** Anything shaped like a job marker, in any case or spacing. */
const MARKER_LIKE = /\[\s*job\s*:[^\]]*\]/gi;

/**
 * A one-line thread title: the agent's title, or the task's first line, then the job marker. Text
 * shaped like a marker is removed from the agent's part first, so a title cannot carry another job's
 * marker and be taken for that job's thread by reconciliation.
 */
export function threadTitle(jobId: string, task: string, title: string | undefined): string {
  const clean = (text: string) => text.replaceAll(MARKER_LIKE, ' ').replaceAll(/\s+/g, ' ').trim();
  const source = clean(title ?? '') || task.split('\n').map(clean).find((line) => line.length > 0) || 'Job';
  const short = source.length > TITLE_FROM_TASK_CHARS ? `${source.slice(0, TITLE_FROM_TASK_CHARS - 1).trimEnd()}…` : source;
  return `${short} ${jobMarker(jobId)}`;
}

/** The marker in every job thread's title; reconciliation finds launched threads by it. */
export function jobMarker(jobId: string): string {
  return `[job:${jobId}]`;
}

/**
 * The job operations behind the work_* tools. Starting a job only records it; the engine
 * (dispatcher and watcher) talks to T3. `wake` lets the engine react at once instead of at its next tick.
 */
export class JobService {
  readonly store: JobStore;
  readonly #config: GatewayConfig;
  readonly #registry: HostRegistry;
  readonly #catalog: CatalogService;
  readonly #threadCatalog: ThreadCatalog;
  readonly #clock: Clock;
  readonly #logger: Logger;
  /** Set by the running gateway so new work is dispatched without waiting for the next poll. */
  wake: () => void = () => {};

  constructor(options: JobServiceOptions) {
    this.store = options.store;
    this.#config = options.config;
    this.#registry = options.registry;
    this.#catalog = options.catalog;
    this.#threadCatalog = new ThreadCatalog(options.registry, options.clock, options.logger);
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  projectAccess(caller: Pick<Caller, 'clientId'>): ProjectAccess { return expandProjectAccess(this.store.projectAccess(caller.clientId), this.#config); }

  allowsProject(caller: Caller, host: string, alias?: string | null, projectId?: string | null): boolean {
    return allowsProject(this.projectAccess(caller), host, alias, projectId);
  }

  /** Check explicit T3 ids, resolving title-only alias grants only when needed. Host authorization comes first. */
  async authorizeProject(caller: Caller, hostId: string, projectId: string, level: AccessLevel = 'read'): Promise<void> {
    this.#hostFor(caller, hostId, level);
    if (this.allowsProject(caller, hostId, null, projectId)) return;
    const access = this.projectAccess(caller);
    const titleAliases = this.#config.projects.filter((p) => p.host === hostId && p.t3ProjectId === undefined &&
      allowsProject(access, hostId, p.alias));
    if (titleAliases.length) {
      const catalog = await this.#catalog.projects(hostId);
      const mapping = mapProjects(this.#config, hostId, catalog.value).get(projectId);
      if (mapping?.aliases.some((p) => titleAliases.includes(p))) return;
    }
    projectDenied();
  }

  project(alias: string): ProjectConfig {
    const project = this.#config.projects.find((candidate) => candidate.alias === alias);
    if (!project) {
      const known = this.#config.projects.map((candidate) => candidate.alias).join(', ') || '(none configured)';
      throw new GatewayError('not_found', `No project "${alias}". Known projects: ${known}. fleet_status lists them.`);
    }
    return project;
  }

  /**
   * A project as an agent may use it: one on a host its grant does not let it read is unknown, as in the
   * error for a missing project, whose list of known projects names only visible ones.
   */
  #projectFor(caller: Caller, alias: string, level: AccessLevel): ProjectConfig {
    const project = this.#config.projects.find((candidate) => candidate.alias === alias);
    if (project && (permits(caller.scopes, 'read', project.host) || permits(caller.scopes, level, project.host)) &&
      !this.allowsProject(caller, project.host, project.alias, project.t3ProjectId)) projectDenied();
    if (project && permits(caller.scopes, level, project.host)) {
      return project;
    }
    if (project && permits(caller.scopes, 'read', project.host)) {
      throw new GatewayError(
        'insufficient_scope',
        `Project "${alias}" is on host ${project.host}, where this agent has read access only. Ask the operator for Operate access on that host.`,
      );
    }
    const known = this.#config.projects.filter((candidate) => permits(caller.scopes, 'read', candidate.host) && this.allowsProject(caller, candidate.host, candidate.alias, candidate.t3ProjectId)).map((candidate) => candidate.alias);
    throw new GatewayError('not_found', `No project "${alias}". Known projects: ${known.join(', ') || '(none configured)'}. fleet_status lists them.`);
  }

  /**
   * A job as an agent may use it, checked before anything is read from T3 or returned from the ledger: a job on
   * a host the agent may not read is reported exactly as an unknown job id; one it may read but not operate is
   * refused with insufficient_scope. The ledger read is limited to the grant's hosts in SQL, so the stored row of a
   * job the agent may not see is not even parsed (a launch plan it cannot read would be reported, and the report
   * would show the job exists).
   */
  #jobFor(caller: Caller, jobId: string, level: AccessLevel): Job {
    const requestedHosts = permittedHosts(caller.scopes, level);
    const readableHosts = permittedHosts(caller.scopes, 'read');
    const scope = requestedHosts === 'all' || readableHosts === 'all'
      ? {} : { hostIds: [...new Set([...requestedHosts, ...readableHosts])] };
    const projects = this.projectAccess(caller);
    const job = this.store.get(jobId, { ...scope, projects });
    if (!job && projects !== undefined) projectDenied();
    if (job && permits(caller.scopes, level, job.hostId)) {
      if (job.origin === 'adopted') {
        this.#requireThreadScope(caller, level);
      }
      return job;
    }
    if (job && permits(caller.scopes, 'read', job.hostId)) {
      throw new GatewayError(
        'insufficient_scope',
        `Job ${job.id} is on host ${job.hostId}, where this agent has read access only. Ask the operator for Operate access on that host.`,
      );
    }
    throw jobNotFound(jobId);
  }

  /** The rows of the ledger an agent may read: its grant's hosts, unless it covers all. */
  #visible(caller: Caller, mine = false): JobScope {
    const hosts = permittedHosts(caller.scopes, 'read');
    return { projects: this.projectAccess(caller), includeAdopted: caller.scopes.includes(THREAD_READ_SCOPE), ...(mine ? { clientId: caller.clientId } : {}), ...(hosts === 'all' ? {} : { hostIds: hosts }) };
  }

  #requireThreadScope(caller: Caller, level: AccessLevel): void {
    if (!caller.scopes.includes(THREAD_READ_SCOPE)) throw new GatewayError('insufficient_scope', 'External threads require threads:read. Ask the operator to grant it with clients grant.');
    if (level === 'operate' && !caller.scopes.includes(THREAD_CONTROL_SCOPE)) {
      throw new GatewayError('insufficient_scope', 'Controlling external threads requires threads:control. Ask the operator to grant it with clients grant.');
    }
  }

  #auditThread(caller: Caller, job: Job, action: Parameters<JobStore['auditThread']>[2]): void {
    this.store.auditThread(job, caller.clientId, action);
  }

  /** v0.1.6 omits lineage.sideChat from MCP reads; its project list excludes side chats. */
  async #requireExternalEligibility(host: string, thread: ThreadRead['thread']): Promise<void> {
    requireExternalEligibility(thread);
    if (thread.relationshipToParent !== 'fork') return;
    const listed = await this.#threadCatalog.read(host, thread.projectId, true);
    if (!listed.value.some((candidate) => candidate.threadId === thread.threadId)) {
      throw new GatewayError('job_state_conflict', 'This fork is not a listed T3 conversation. Side chats cannot be adopted or resumed; use the parent thread in T3.');
    }
  }

  /** Imported threads can be reconfigured in T3. Resuming must not bypass the current project or host ceiling. */
  async #validateAdoptedResume(job: Job): Promise<void> {
    if (job.origin !== 'adopted' || job.threadId === null) return;
    const host = this.#config.hosts.find((candidate) => candidate.id === job.hostId);
    if (!host) throw new GatewayError('not_found', 'The adopted thread host is no longer configured.');
    // State only, messages view; no history is needed to validate the resume policy.
    const { thread } = await this.#registry.client(job.hostId).readThread({
      threadId: job.threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1,
    });
    await this.#requireExternalEligibility(job.hostId, thread);
    if (thread.threadId !== job.threadId || thread.projectId !== job.t3ProjectId) {
      throw new GatewayError('job_state_conflict', 'The imported thread changed project or is no longer a resumable thread. Check it in T3.');
    }
    const projects = (await this.#catalog.projects(job.hostId, { refresh: true })).value;
    const mapping = mapProjects(this.#config, job.hostId, projects).get(thread.projectId);
    if (!mapping) throw new GatewayError('not_found', 'The adopted thread project is no longer available.');
    const policy = launchPolicy(host, mapping);
    if (policy.kind === 'ambiguous') throw new GatewayError('job_state_conflict', 'The adopted thread project has ambiguous configured aliases.');
    const ceiling = policy.kind === 'alias' ? policy.project.runtimeMode : host.discovery.runtimeMode;
    const mode = RUNTIME_MODES.find((candidate) => candidate === thread.runtimeMode);
    if (!mode || !runtimeModeAllowed(mode, host.access) || RUNTIME_MODES.indexOf(mode) > RUNTIME_MODES.indexOf(ceiling)) {
      throw new GatewayError('job_state_conflict', 'The imported thread runtime mode is unknown or exceeds its current project/host ceiling. Nothing was sent. Review it in T3.');
    }
    if (isTerminal(this.store.require(job.id).state)) {
      throw new GatewayError('job_state_conflict', 'The adopted job was released while its resume was being checked. Nothing was sent.');
    }
  }

  /**
   * A host as an agent may use it: one that is not configured, or that its grant does not let it read,
   * is unknown; one it may read but not operate is refused with insufficient_scope.
   */
  #hostFor(caller: Caller, hostId: string, level: AccessLevel): HostConfig {
    const host = this.#config.hosts.find((candidate) => candidate.id === hostId);
    if (host && permits(caller.scopes, level, host.id)) return host;
    if (host && permits(caller.scopes, 'read', host.id)) {
      throw new GatewayError('insufficient_scope', `This agent has read access only on host ${host.id}. Ask the operator for Operate access on that host.`);
    }
    throw new GatewayError('not_found', `No host "${hostId}". fleet_status lists the hosts you can use.`);
  }

  /**
   * Start a job. A repeated request id is answered first, from the ledger and the grant alone: it returns its job (if the
   * agent may operate on that job's host, the one it was started on, whatever the configuration says now), a reused
   * one with different input is refused (`request_id_conflict`), and nothing is read from T3 or from the current
   * project configuration. Then the host is authorized. A configured alias without a model selection is
   * recorded at once and resolved at dispatch: a worktree alias with no stored plan, a scratch alias (or the host's
   * default, for `target: { host }`) with a plan built from the configuration alone. Neither needs the host to be up,
   * so both queue while it is down. A request with a `target.projectId` or a selection on a worktree alias is resolved
   * now against the host's catalogs (read-only; nothing is created until that returns), and its launch spec is
   * recorded with the job. Discovery is required only for what discovery is: an explicit `projectId` and a model
   * selection. The host's own default scratch alias needs none.
   */
  async start(caller: Caller, input: StartInput): Promise<{ job: Job; created: boolean }> {
    if ((input.project === undefined) === (input.target === undefined)) {
      throw new GatewayError('invalid_argument', 'Pass exactly one of project (a configured alias) or target ({ host } for no named project, or { host, projectId } from fleet_projects).');
    }
    const hash = startInputHash(input);
    const key = this.store.idempotencyKey(caller.clientId, 'work_start', input.requestId);
    // A retry returns the job of the first request, which the project config may since have moved to another host:
    // the agent must still be allowed to operate on the job's own host. The lookup is limited to those hosts in SQL.
    const hosts = permittedHosts(caller.scopes, 'operate');
    const scope: JobScope = { projects: this.projectAccess(caller), ...(hosts === 'all' ? {} : { hostIds: hosts }) };
    const replayed = key && this.store.get(key.jobId, scope);
    if (key && !replayed) {
      throw new GatewayError(
        'insufficient_scope',
        `requestId "${input.requestId}" belongs to a job on a host this agent may not operate on. Use a new requestId for new work.`,
      );
    }
    if (key && replayed) {
      if (key.inputHash !== hash) {
        throw new GatewayError('request_id_conflict', `requestId "${input.requestId}" was already used for a different request. Use a new requestId for new work.`);
      }
      // A retry of a request made before the operator turned work_start off still gets its job back.
      return { job: replayed, created: false };
    }
    let project = input.project === undefined ? undefined : this.#projectFor(caller, input.project, 'operate');
    const host = project ? this.#hostFor(caller, project.host, 'operate') : this.#hostFor(caller, input.target!.host, 'operate');
    if (input.target?.projectId !== undefined) await this.authorizeProject(caller, host.id, input.target.projectId, 'operate');
    const hostOnly = input.target !== undefined && input.target.projectId === undefined;
    if (!host.discovery.enabled && (input.target?.projectId !== undefined || input.modelSelection !== undefined)) {
      throw new GatewayError(
        'discovery_disabled',
        `Host ${host.id} has discovery disabled: work_start there takes a configured project alias (fleet_status lists them), or target { host } for its default scratch alias, and no explicit projectId or modelSelection.`,
      );
    }
    if (hostOnly) {
      if (host.defaultProject === undefined) {
        throw new GatewayError('not_found', `Host ${host.id} has no default scratch project. Ask the operator to configure defaultProject.`);
      }
      project = this.#projectFor(caller, host.defaultProject, 'operate');
      if (project.host !== host.id || project.workspaceMode !== 'scratch') {
        throw new GatewayError('invalid_argument', `Host ${host.id} defaultProject must be a scratch alias on that host.`);
      }
    }
    if (input.workspace !== undefined) {
      if (project?.workspaceMode === 'scratch') {
        throw new GatewayError('invalid_argument', 'Scratch projects run in T3\'s own scratch workspace and take no workspace choice.');
      }
      if (host.workspaceProbeCommand === undefined) {
        throw new GatewayError(
          'invalid_argument',
          `Host ${host.id} does not choose workspaces: its operator has not configured a workspaceProbeCommand, so work_start there takes no workspace. ` +
            'Named projects there run in a fresh worktree from the project\'s local base branch.',
        );
      }
    }
    if (project?.workspaceMode === 'worktree' && input.target === undefined && input.modelSelection === undefined) {
      if (!project.allowWorkStart) throw this.#startDisabled(caller, project);
      const id = newJobId();
      // A host without a probe keeps the plain record: no launch spec, resolved from the configuration at dispatch. A host with one
      // records only what was asked for (nothing is read from T3 or the host now); the dispatcher resolves the folder and the workspace.
      const aliasOnly = host.workspaceProbeCommand === undefined ? undefined : this.#aliasLaunch(project, input);
      const result = this.store.create({
        id,
        clientId: caller.clientId,
        requestId: input.requestId,
        inputHash: hash,
        projectAlias: project.alias,
        hostId: project.host,
        task: input.task,
        attachments: validateAttachments(input.attachments),
        title: threadTitle(id, input.task, input.title),
        branch: aliasOnly?.workspace.type === 'root' ? '' : `${project.branchPrefix}${id}`,
        runtimeMode: project.runtimeMode,
        ...(aliasOnly ? { launchSpec: aliasOnly } : {}),
      }, scope);
      if (result.created) this.wake();
      return result;
    }
    const { spec, branchPrefix } = await (async () => {
      try {
        const plan = project?.workspaceMode === 'scratch' && input.target?.projectId === undefined
          ? await this.#scratchLaunch(caller, host, project, input)
          : await this.#resolveLaunch(caller, host, project, input);
        this.#registry.signals(host.id).record('start');
        return plan;
      } catch (error) {
        this.#registry.signals(host.id).record('start', error);
        throw error;
      }
    })();
    if (!this.allowsProject(caller, host.id, spec.alias, spec.projectId)) projectDenied();
    const id = newJobId();
    const result = this.store.create({
      id,
      clientId: caller.clientId,
      requestId: input.requestId,
      inputHash: hash,
      projectAlias: spec.alias ?? projectRef(host.id, spec.projectId!),
      hostId: host.id,
      task: input.task,
      attachments: validateAttachments(input.attachments),
      title: threadTitle(id, input.task, input.title),
      // A root job runs in the project's own folder, on whatever branch is checked out there: it has none of its own.
      branch: spec.v === 2 || (spec.v === 3 && spec.workspace.type === 'root') ? '' : `${branchPrefix}${id}`,
      runtimeMode: spec.runtimeMode,
      t3ProjectId: spec.projectId,
      launchSpec: spec,
    }, scope);
    if (result.created) this.wake();
    return result;
  }

  /**
   * The record of an alias-only request on a host that chooses workspaces: the intent, with the alias's configured
   * policy (runtime mode, model, base ref) as it is now. Nothing about the project is read from T3 or the host.
   */
  #aliasLaunch(project: ProjectConfig, input: StartInput): Extract<LaunchSpec, { v: 3 }> {
    const configured = configuredModel(this.#config, project);
    return {
      v: 3,
      projectId: null,
      projectName: null,
      source: 'alias',
      alias: project.alias,
      runtimeMode: project.runtimeMode,
      model: configured ? { source: configured.source, selection: configured.selection } : { source: 't3_default', selection: null },
      hostId: project.host,
      workspace: workspaceIntent(input.workspace, project.baseRef),
    };
  }

  #startDisabled(caller: Caller, project: ProjectConfig): GatewayError {
    const standing = this.store.standingJobs(project.alias, this.#visible(caller)).filter((job) =>
      permits(caller.scopes, 'read', job.hostId) && this.allowsProject(caller, job.hostId, job.projectAlias, job.t3ProjectId) && (job.origin !== 'adopted' || caller.scopes.includes(THREAD_READ_SCOPE)));
    return new GatewayError('start_disabled', startDisabledMessage(project.alias, standing));
  }

  /**
   * The launch plan of a scratch alias, built from the configuration alone: its pin, runtime mode and model come from the
   * config, and nothing about the project is read from T3 (the dispatcher checks the pin against the host's projects right
   * before the launch). A host that is down therefore still takes the job, and no T3 project name is ever recorded.
   * An explicit model selection is the exception: it is validated against the host's fresh catalog now and again at dispatch.
   */
  async #scratchLaunch(
    caller: Caller,
    host: HostConfig,
    project: ProjectConfig,
    input: StartInput,
  ): Promise<{ spec: LaunchSpec; branchPrefix: string }> {
    if (!project.allowWorkStart) throw this.#startDisabled(caller, project);
    let model: LaunchSpec['model'];
    if (input.modelSelection) {
      const providers = (await this.#catalog.models(host.id, { refresh: true, search: input.modelSelection.model })).value;
      model = { source: 'explicit', selection: { ...validateSelection(host.id, providers, input.modelSelection) } };
    } else {
      const configured = configuredModel(this.#config, project);
      model = configured ? { source: configured.source, selection: configured.selection } : { source: 't3_default', selection: null };
    }
    return {
      spec: {
        v: 2,
        projectId: project.t3ProjectId!,
        projectName: null,
        source: 'alias',
        alias: project.alias,
        runtimeMode: project.runtimeMode,
        model,
        hostId: host.id,
        workspace: { kind: 'scratch' },
        defaultProject: input.target !== undefined && input.target.projectId === undefined ? project.alias : null,
      },
      branchPrefix: project.branchPrefix,
    };
  }

  /**
   * Resolve a target or a model selection against the host's catalogs (read-only; nothing is created
   * until this returns). A target that exactly one configured alias maps to is launched as that alias,
   * with all of its settings; several matching aliases or an ambiguous title mapping require the alias;
   * otherwise the host's discovery policy applies, and launches need `discovery.allowWorkStart`. An
   * explicit selection must match the host's fresh capabilities exactly; nothing is substituted.
   *
   * The project list is read from the host now, never from the browse cache: the policy follows the
   * projects' titles, and a project renamed since an agent browsed could otherwise be launched under
   * the wrong policy. A host that cannot answer fails the request (the error propagates); nothing is
   * resolved from an older snapshot. The dispatcher repeats this check right before the launch.
   */
  async #resolveLaunch(
    caller: Caller,
    host: HostConfig,
    project: ProjectConfig | undefined,
    input: StartInput,
  ): Promise<{ spec: LaunchSpec; branchPrefix: string }> {
    const projects = (await this.#catalog.projects(host.id, { refresh: true })).value;
    const mappings = mapProjects(this.#config, host.id, projects);
    let found: CatalogProject | undefined;
    let policy: ProjectConfig | HostConfig['discovery'];
    let alias: string | null;
    if (project) {
      found = project.t3ProjectId === undefined
        ? [...mappings.values()].find((mapping) => mapping.aliases.includes(project))?.project
        : projects.find((candidate) => candidate.id === project.t3ProjectId);
      if (!found) {
        const what = project.t3ProjectId === undefined ? `exactly one T3 project titled "${project.t3ProjectTitle}"` : `a T3 project with id ${project.t3ProjectId}`;
        throw new GatewayError('not_found', `Project "${project.alias}": host ${host.id} has no ${what}.`);
      }
      if (!project.allowWorkStart) throw this.#startDisabled(caller, project);
      policy = project;
      alias = project.alias;
    } else {
      const mapping = input.target?.projectId === undefined ? undefined : mappings.get(input.target.projectId);
      if (!mapping) {
        throw new GatewayError('not_found', `Host ${host.id} has no T3 project ${JSON.stringify(input.target!.projectId)}. fleet_projects lists them.`);
      }
      found = mapping.project;
      if (!this.allowsProject(caller, host.id, null, mapping.project.id) &&
        !mapping.aliases.some((p) => this.allowsProject(caller, host.id, p.alias, mapping.project.id))) projectDenied();
      const resolved = launchPolicy(host, mapping);
      if (resolved.kind === 'ambiguous') {
        throw new GatewayError(
          'invalid_argument',
          `T3 project ${found.id} on host ${host.id} is configured under ${resolved.aliases.length === 1 ? 'alias' : 'aliases'} ${resolved.aliases.join(', ')}` +
            `${resolved.aliases.length === 1 ? ', whose title matches several T3 projects' : ''}. Start it with project set to the alias you mean, not with target.`,
        );
      }
      if (resolved.kind === 'alias') {
        if (!resolved.project.allowWorkStart) throw this.#startDisabled(caller, resolved.project);
        policy = resolved.project;
        alias = resolved.project.alias;
      } else {
        if (!host.discovery.allowWorkStart) {
          const aliases = this.#config.projects.filter((candidate) => candidate.host === host.id && candidate.allowWorkStart &&
            this.allowsProject(caller, candidate.host, candidate.alias, candidate.t3ProjectId)).map((candidate) => candidate.alias);
          throw new GatewayError(
            'start_disabled',
            `Host ${host.id} does not accept work_start into T3 projects without a configured alias (discovery.allowWorkStart is false). ` +
              `Projects that accept work there: ${aliases.join(', ') || '(none)'}. Ask the operator to configure the project or enable discovery launches.`,
          );
        }
        policy = host.discovery;
        alias = null;
      }
    }
    let model: LaunchSpec['model'];
    if (input.modelSelection) {
      const providers = (await this.#catalog.models(host.id, { refresh: true, search: input.modelSelection.model })).value;
      model = { source: 'explicit', selection: { ...validateSelection(host.id, providers, input.modelSelection) } };
    } else if (alias !== null) {
      const configured = configuredModel(this.#config, policy as ProjectConfig);
      model = configured ? { source: configured.source, selection: configured.selection } : { source: 't3_default', selection: null };
    } else if (host.defaultModelSelection) {
      model = { source: 'host', selection: host.defaultModelSelection };
    } else if (found.hasDefaultModel) {
      model = { source: 't3_default', selection: null };
    } else {
      throw new GatewayError(
        'invalid_argument',
        `T3 project ${found.id} on host ${host.id} has no default model and the host sets no defaultModelSelection: pass modelSelection ` +
          '({ instanceId, model, options? } from fleet_models).',
      );
    }
    const scratch = alias === null ? undefined : this.#config.projects.find((candidate) => candidate.alias === alias && candidate.workspaceMode === 'scratch');
    if (scratch && input.workspace !== undefined) {
      throw new GatewayError('invalid_argument', 'Scratch projects run in T3\'s own scratch workspace and take no workspace choice.');
    }
    const common = {
      projectId: found.id,
      source: alias === null ? 'discovered' : 'alias',
      alias,
      runtimeMode: policy.runtimeMode,
      model,
    } satisfies Pick<LaunchSpec, 'projectId' | 'source' | 'alias' | 'runtimeMode' | 'model'>;
    return {
      // A pinned scratch project reached by its id is a scratch launch like the alias itself: no name recorded, no branch.
      spec: scratch ? {
        v: 2,
        ...common,
        projectName: null,
        hostId: host.id,
        workspace: { kind: 'scratch' },
        defaultProject: null,
      } : host.workspaceProbeCommand !== undefined ? {
        // The host chooses workspaces: the folder and the workspace are decided at dispatch; only the intent is recorded.
        v: 3,
        ...common,
        projectName: found.name,
        hostId: host.id,
        workspace: workspaceIntent(input.workspace, policy.baseRef),
      } : {
        v: 1,
        ...common,
        projectName: found.name,
        baseRef: policy.baseRef,
      },
      branchPrefix: policy.branchPrefix,
    };
  }

  async list(
    filter: {
      project?: string | undefined;
      target?: { host: string; projectId: string } | undefined;
      states?: readonly JobState[] | undefined;
      mine?: boolean | undefined;
      limit: number;
    },
    caller: Caller,
  ): Promise<Job[]> {
    // A configured alias, or the internal ref of a job targeted by T3 project id (@<host>/<projectId>): its host is
    // authorized like any host, and the ref is only a filter on the ledger.
    if (filter.project !== undefined) {
      const ref = parseProjectRef(filter.project);
      if (ref) {
        this.#hostFor(caller, ref.hostId, 'read');
        await this.authorizeProject(caller, ref.hostId, ref.projectId);
      }
      else this.#projectFor(caller, filter.project, 'read');
    }
    if (filter.target !== undefined) {
      this.#hostFor(caller, filter.target.host, 'read');
      await this.authorizeProject(caller, filter.target.host, filter.target.projectId);
    }
    return this.store.list({
      limit: filter.limit,
      ...(filter.project === undefined ? {} : { projectAlias: filter.project }),
      ...(filter.target === undefined ? {} : { target: { hostId: filter.target.host, projectId: filter.target.projectId } }),
      ...(filter.states === undefined ? {} : { states: filter.states }),
      ...this.#visible(caller, filter.mine ?? false),
    });
  }

  /** One job with its recent events and, read live from T3, the questions it waits on. */
  async status(caller: Caller, jobId: string, pendingRequestId?: string): Promise<JobDetail> {
    const job = this.#jobFor(caller, jobId, 'read');
    if (pendingRequestId !== undefined && !job.pendingRequestIds.includes(pendingRequestId)) {
      throw new GatewayError('not_found', 'That request is not pending on this job. Read work_status without pendingRequestId for the current list.');
    }
    // State only, messages view: settlement belongs to T3 and is never inferred from the ledger.
    let settlement: { settled: boolean | null; settledAt: string | null } = { settled: null, settledAt: null };
    if (job.threadId !== null) {
      try {
        const read = await this.#registry.client(job.hostId).readThread({
          threadId: job.threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1,
        });
        settlement = { settled: read.thread.settled ?? null, settledAt: read.thread.settledAt ?? null };
      } catch { /* A host that cannot answer leaves settlement unknown; ledger status remains available. */ }
    }
    const pendingRequests = await Promise.all(
      job.pendingRequestIds.map(async (requestId, index): Promise<QuestionRequest> => {
        if (pendingRequestId !== undefined ? requestId !== pendingRequestId : index >= MAX_QUESTION_READS) {
          return { requestId, questions: null, questionsUnavailable: 'read_limit' };
        }
        if (job.threadId === null) return { requestId, questions: null, questionsUnavailable: 'temporarily_unreadable' };
        return this.#questions(job.hostId, job.threadId, requestId);
      }),
    );
    return {
      job,
      ...settlement,
      recentEvents: this.store.recentEvents(jobId, 10),
      pendingRequests,
      waitingForApproval: job.state === 'needs_input' && job.pendingRequestIds.length === 0,
    };
  }

  /** A page of the job thread's worker messages, read live from T3 (see messages.ts). */
  async messages(caller: Caller, jobId: string, query: MessageQuery): Promise<{ job: Job; page: MessagePage }> {
    const job = this.#jobFor(caller, jobId, 'read');
    if (query.before !== undefined && query.after !== undefined) throw new GatewayError('invalid_argument', 'Pass before or after, not both.');
    if (job.threadId === null) throw new GatewayError('job_state_conflict', `Job ${jobId} has no T3 thread yet (${job.state}), so it has no messages.`);
    return { job, page: await readWorkerMessages(this.#registry.client(job.hostId), job.threadId, job.readPosition, query) };
  }

  async #questions(hostId: string, threadId: string, requestId: string): Promise<QuestionRequest> {
    try {
      const request = await this.#registry.client(hostId).readPendingRequest(threadId, requestId, { timeoutMs: QUESTION_READ_TIMEOUT_MS });
      if (request.questions === null) return { requestId, questions: null, questionsUnavailable: 'temporarily_unreadable' };
      const questions = request.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: question.options.map((option) => ({ label: option.label, description: option.description, value: option.value ?? null })),
        multiSelect: question.multiSelect ?? null,
        allowCustomAnswer: question.allowCustomAnswer ?? null,
        required: question.required ?? null,
      }));
      if (questions.length > MAX_QUESTIONS || questions.some((question) => question.options.length > MAX_QUESTION_OPTIONS) ||
          JSON.stringify(questions).length > MAX_QUESTION_CHARS) {
        return { requestId, questions: null, questionsUnavailable: 'too_large' };
      }
      return { requestId, questions, questionsUnavailable: null };
    } catch (error) {
      this.#logger.debug('jobs.question_read_failed', { hostId, errorCode: describeError(error).code });
      return { requestId, questions: null, questionsUnavailable: 'temporarily_unreadable' };
    }
  }

  /**
   * Adopt an existing T3 thread as a standing job (operator CLI only). The thread must belong to the
   * project's T3 project. Its state comes from a read now, and both read positions (messages and
   * activity view) start at the thread's current end, so the watcher follows only what happens from now
   * on; delegated work still running is found by a bounded scan back through the activity view
   * (scanActivity). Adopting a thread that is already a standing job of the project returns that job
   * (`created: false`).
   */
  async adopt(input: AdoptInput): Promise<{ job: Job; created: boolean }> {
    if (!isThreadId(input.threadId)) throw new GatewayError('invalid_argument', 'Invalid T3 thread id.');
    const project = this.project(input.project);
    const existing = this.store.openJobForThread(input.threadId, project.host);
    if (existing?.standing && existing.projectAlias === project.alias) return { job: existing, created: false };
    const { id } = await resolveProject(this.#registry, project);
    return this.#adoptThread(project, id, input);
  }

  async #adoptThread(project: { alias: string; host: string }, projectId: string, input: AdoptInput,
    adoption?: { clientId: string; requestId: string; inputHash: string }): Promise<{ job: Job; created: boolean }> {
    const client = this.#registry.client(project.host);
    let read: ThreadRead;
    let questions: string[];
    let activity: ActivityRead;
    try {
      read = await readToEnd(client, input.threadId);
      questions = await client.listPendingRequests(input.threadId);
      activity = await scanActivity(client, input.threadId, read.items.at(-1)?.position ?? read.nextPosition);
    } catch (error) {
      if (error instanceof T3ToolError && /not_found/.test(error.t3Code)) {
        throw new GatewayError('not_found', `Host ${project.host} has no T3 thread ${input.threadId} (${error.t3Code}).`);
      }
      throw error;
    }
    const { thread } = read;
    if (adoption && (thread.threadId !== input.threadId || thread.projectId !== projectId)) {
      throw new GatewayError('not_found', 'No thread in that project.');
    }
    if (adoption) await this.#requireExternalEligibility(project.host, thread);
    if (thread.projectId !== projectId) {
      throw new GatewayError(
        'invalid_argument',
        `Thread ${input.threadId} belongs to T3 project ${thread.projectId}, not to project "${project.alias}" (T3 project ${projectId}).`,
      );
    }
    // A launch with a lost response may not have bound its thread id yet. Its gateway marker still owns the thread.
    if (adoption) {
      const marker = /\[job:([a-z0-9]{10})\]/.exec(thread.title)?.[1];
      const owner = marker && this.store.get(marker, { hostIds: [project.host], projects: this.projectAccess(adoption) });
      if (owner && owner.origin === 'gateway') throw new GatewayError('job_state_conflict', 'This thread belongs to a gateway launch. Use its existing job.');
    }
    const lastRunId = thread.activeRunId ?? thread.latestRunId;
    const seen = observe(
      {
        state: 'idle',
        lastRunId,
        readPosition: null,
        activityPosition: null,
        threadLink: null,
        latestActivityAt: null,
        standing: true,
        delegatedWork: [],
        delegatedUntracked: 0,
        delegatedUntrackedRunId: null,
      },
      read,
      questions,
      activity,
    );
    const runtimeMode = (thread as { runtimeMode?: unknown }).runtimeMode;
    return this.store.adopt({
      id: newJobId(),
      projectAlias: project.alias,
      hostId: project.host,
      t3ProjectId: projectId,
      state: seen.state,
      title: cleanThreadTitle(input.title ?? thread.title),
      branch: thread.branch ?? '',
      runtimeMode: typeof runtimeMode === 'string' ? runtimeMode : '',
      threadId: thread.threadId,
      threadTitle: cleanThreadTitle(thread.title),
      threadLink: threadLinkTarget(thread.link),
      lastRunId: seen.lastRunId,
      pendingRequestIds: seen.pendingRequestIds,
      latestMessageExcerpt: seen.excerpt ?? null,
      latestMessageTruncated: seen.excerptTruncated ?? false,
      latestActivityAt: seen.activityAt,
      readPosition: seen.readPosition,
      activityPosition: seen.activityPosition,
      lastErrorCode: seen.errorCode ?? null,
      lastErrorMessage: seen.errorCode ? 'The latest T3 run failed. Open the thread in T3 for details.' : null,
      delegatedWork: seen.delegatedWork,
      delegatedUntracked: seen.delegatedUntracked,
      delegatedUntrackedRunId: seen.delegatedUntrackedRunId,
    }, adoption);
  }

  /** Client adoption never launches, sends, configures or organizes the T3 thread. */
  async adoptExternal(caller: Caller, input: { host: string; projectId: string; threadId: string; requestId: string }): Promise<{ job: Job; created: boolean }> {
    this.#requireThreadScope(caller, 'operate');
    const host = this.#hostFor(caller, input.host, 'operate');
    await this.authorizeProject(caller, host.id, input.projectId, 'operate');
    if (!isThreadId(input.threadId)) throw new GatewayError('invalid_argument', 'Invalid T3 thread id.');
    const hash = inputHash('work_adopt', { host: input.host, projectId: input.projectId, threadId: input.threadId });
    const key = this.store.idempotencyKey(caller.clientId, 'work_adopt', input.requestId);
    if (key) {
      const job = this.#jobFor(caller, key.jobId, 'operate');
      if (key.inputHash !== hash) throw new GatewayError('request_id_conflict', 'This requestId was used for a different adoption.');
      this.#auditThread(caller, job, 'adopt_replayed');
      return { job, created: false };
    }
    if (!host.discovery.enabled) throw new GatewayError('discovery_disabled', 'Thread adoption needs discovery.enabled on this host.');
    const existing = this.store.jobForThread(host.id, input.threadId, { projects: this.projectAccess(caller) });
    if (existing && existing.t3ProjectId !== input.projectId) throw new GatewayError('not_found', 'No thread in that project.');
    if (existing && existing.origin !== 'adopted') {
      throw new GatewayError('job_state_conflict', 'This thread already has a gateway or operator-owned job. Use that job with the appropriate scopes.');
    }
    if (existing) {
      const replay = this.store.adopt({ ...existing, threadId: input.threadId, threadTitle: existing.threadTitle ?? existing.title, t3ProjectId: input.projectId },
        { clientId: caller.clientId, requestId: input.requestId, inputHash: hash });
      this.#auditThread(caller, replay.job, 'adopt_replayed');
      return replay;
    }
    const projects = (await this.#catalog.projects(host.id, { refresh: true })).value;
    if (!projects.some((project) => project.id === input.projectId)) throw new GatewayError('not_found', 'No project with that id on this host.');
    const mapping = mapProjects(this.#config, host.id, projects).get(input.projectId)!;
    const policy = launchPolicy(host, mapping);
    if (policy.kind === 'ambiguous') throw new GatewayError('invalid_argument', 'This project has ambiguous configured aliases. Ask the operator to resolve them.');
    const project = { alias: policy.kind === 'alias' ? policy.project.alias : projectRef(host.id, input.projectId), host: host.id };
    const result = await this.#adoptThread(project, input.projectId, { project: project.alias, threadId: input.threadId },
      { clientId: caller.clientId, requestId: input.requestId, inputHash: hash });
    if (!result.created) this.#auditThread(caller, result.job, 'adopt_replayed');
    this.wake();
    return result;
  }

  /**
   * Stop following a standing job (operator CLI only): it becomes `released`. T3 is not contacted,
   * so the thread and any run on it carry on untouched. `released` is false when it was already finished.
   */
  release(jobId: string): { job: Job; released: boolean } {
    const job = this.store.require(jobId);
    if (!job.standing) {
      throw new GatewayError(
        'invalid_argument',
        `Job ${job.id} was started by an agent, not adopted; only standing jobs are released. Stop it with work_cancel instead.`,
      );
    }
    this.store.auditThread(job, 'operator', 'release');
    const released = this.store.transition(job.id, { from: OPEN_STATES, to: 'released', detail: { reason: 'released' } });
    return released ? { job: released, released: true } : { job: this.store.require(job.id), released: false };
  }

  /** Settle only a quiet finished thread. T3 remains the final authority at the mutation boundary. */
  async settle(caller: Caller, input: { jobId: string; requestId: string }): Promise<{
    job: Job; settled: boolean; settledAt: string | null; replayed: boolean;
  }> {
    const job = this.#jobFor(caller, input.jobId, 'operate');
    this.#auditThread(caller, job, 'settle');
    const hash = inputHash('work_settle', { jobId: input.jobId });
    const key = this.store.idempotencyKey(caller.clientId, 'work_settle', input.requestId);
    if (key && (key.jobId !== job.id || key.inputHash !== hash)) {
      throw new GatewayError('request_id_conflict', 'This requestId was used for a different work_settle request. Use a new requestId.');
    }
    if (key?.response) {
      const stored = JSON.parse(key.response) as { settled: boolean; settledAt: string | null };
      return { job, ...stored, replayed: true };
    }
    if (job.threadId === null || !['idle', 'cancelled', 'failed', 'released'].includes(job.state)) {
      throw new GatewayError('job_state_conflict', 'work_settle needs an idle, cancelled, failed or released job with a T3 thread.');
    }
    const client = this.#registry.client(job.hostId);
    // Messages view for thread/run state; delegated work is checked separately in the activity view below.
    const readState = () => client.readThread({ threadId: job.threadId!, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 });
    const before = await readState();
    if (key) {
      // There is no T3 request key for organize. A crash/lost reply must never settle a resumed thread again.
      if (before.thread.settled !== true) {
        throw new GatewayError('t3_response_lost', 'The earlier settlement outcome is unknown. Nothing was sent again. Check work_status; use a new requestId only for a new settlement.');
      }
    } else {
      if (before.thread.settled === undefined) {
        throw new GatewayError('t3_invalid_response', 'This T3 host does not report settlement state; work_settle cannot confirm its result.');
      }
      if (before.thread.archived || before.thread.activeRunId !== null || isActiveStatus(before.thread.status) ||
          before.recentRuns.some((run) => isActiveStatus(run.status))) {
        throw new GatewayError('job_state_conflict', 'The T3 thread is busy or archived. Finish or cancel its turn and queued messages before settling.');
      }
      // Fresh, complete, bounded activity scan, including terminal/released jobs the watcher no longer follows.
      // A partial scan cannot prove absence of delegated work, so fail closed at 2,000 items.
      let afterPosition: number | null = null;
      for (let page = 0; ; page++) {
        const read = await client.readThread({
          threadId: job.threadId, view: 'activity', afterPosition, limit: 100, runLimit: 1, maxCharsPerItem: 1,
        });
        if (read.items.some(isDelegatedWorkActive)) {
          throw new GatewayError('job_state_conflict', 'The thread is waiting on delegated work. Wait for it to end before settling.');
        }
        if (!read.hasMore) break;
        if (page >= 19 || read.nextPosition === null || read.nextPosition === afterPosition) {
          throw new GatewayError('job_state_conflict', 'Delegated work could not be checked completely within the settlement scan limit. Settle this thread in T3.');
        }
        afterPosition = read.nextPosition;
      }
      if (!this.store.claimSettlement(caller.clientId, input.requestId, { inputHash: hash, jobId: job.id })) {
        return this.settle(caller, input);
      }
      try {
        await client.settleThread(job.threadId);
      } catch (error) {
        const permissionDenied = error instanceof T3ToolError &&
          ['capability_denied', 'runtime_mode_escalation_denied', 'interaction_mode_escalation_denied'].includes(error.t3Code);
        const stateRefused = error instanceof T3ToolError && error.t3Code === 'orchestration_error' &&
          /is still running|has a queued message|is waiting on an approval or question|is archived/.test(error.message);
        if (permissionDenied || stateRefused || (error instanceof T3TransportError && error.delivery === 'not_delivered')) {
          this.store.releaseIdempotencyKey(caller.clientId, 'work_settle', input.requestId);
        }
        if (permissionDenied) {
          throw new GatewayError('t3_unauthorized', 'The existing host credential does not permit settling this thread. Ask the operator to review its T3 access.');
        }
        if (stateRefused) {
          throw new GatewayError('job_state_conflict', 'T3 refused settlement: the thread is busy, has queued messages or pending approvals, or is archived. Check it in T3 before retrying.');
        }
        if (!(error instanceof T3ToolError) && !(error instanceof T3TransportError && error.delivery === 'unknown')) throw error;
        // An ambiguous write is read back once, never sent again.
      }
    }
    const after = await readState();
    if (after.thread.settled !== true) {
      throw new GatewayError('t3_response_lost', 'T3 has not confirmed settlement. Nothing will be sent again for this requestId. Check work_status.');
    }
    const result = { settled: true, settledAt: after.thread.settledAt ?? null };
    this.store.recordSettlement(job.id, caller.clientId, input.requestId, result);
    return { job: this.store.require(job.id), ...result, replayed: key !== undefined };
  }

  /**
   * Send a follow-up instruction to the job's thread. Idempotent on requestId: a delivered request is
   * not sent again, and a request whose first attempt had an unknown outcome is re-sent with the same
   * T3 clientRequestId under the same durably bound authorization identity. Attachment sends instead keep a durable uncertainty marker and never resend.
   */
  readonly #attachmentContinues = new Set<string>();

  async continue(caller: Caller, input: ContinueInput): Promise<ContinueResult> {
    if (!input.attachments?.length) return this.#continue(caller, input);
    // Authorize and audit every invocation, including one refused by the in-flight guard.
    const job = this.#jobFor(caller, input.jobId, 'operate');
    this.#auditThread(caller, job, 'continue');
    const lock = JSON.stringify([caller.clientId, input.requestId]);
    if (this.#attachmentContinues.has(lock)) throw new GatewayError('job_state_conflict', 'This attachment follow-up is in progress. Retry the same requestId later.');
    this.#attachmentContinues.add(lock);
    try { return await this.#continue(caller, input, true); }
    finally { this.#attachmentContinues.delete(lock); }
  }

  async #continue(caller: Caller, input: ContinueInput, audited = false): Promise<ContinueResult> {
    // Before the request id is looked up, so a replay never returns a stored result for a job the agent may not operate.
    let job = this.#jobFor(caller, input.jobId, 'operate');
    if (!audited) this.#auditThread(caller, job, 'continue');
    const attachments = validateAttachments(input.attachments);
    const hash = inputHash('work_continue', { jobId: input.jobId, message: input.message,
      ...(attachments.length ? { attachments: attachmentHashes(attachments) } : {}),
    });
    const key = this.store.idempotencyKey(caller.clientId, 'work_continue', input.requestId);
    if (key) {
      if (key.jobId !== input.jobId || key.inputHash !== hash) {
        throw new GatewayError('request_id_conflict', `requestId "${input.requestId}" was already used for a different request. Use a new requestId.`);
      }
      if (key.response !== null) {
        const stored = JSON.parse(key.response) as { delivery?: string; attachmentOutcome?: string; sendIdentity?: string };
        if (stored.attachmentOutcome === 'unknown') throw attachmentOutcomeUnknown();
        if (!stored.sendIdentity) return { job, delivery: stored.delivery ?? 'unknown', replayed: true };
      }
    } else {
      if (!['idle', 'running', 'needs_input'].includes(job.state) || job.threadId === null) {
        throw new GatewayError('job_state_conflict', `Job ${job.id} is ${job.state}; work_continue needs a job that is idle, running or needs_input.`);
      }
      this.store.claimIdempotencyKey(caller.clientId, 'work_continue', input.requestId, { inputHash: hash, jobId: job.id });
    }
    const threadId = job.threadId;
    if (threadId === null) throw new GatewayError('job_state_conflict', `Job ${job.id} has no thread.`);
    try {
      await this.#validateAdoptedResume(job);
    } catch (error) {
      if (!key) this.store.releaseIdempotencyKey(caller.clientId, 'work_continue', input.requestId);
      throw error;
    }
    // Resuming an idle job that works in the project's own folder takes the folder back first, before anything is sent: while
    // another job holds it the follow-up waits, and the same requestId may be sent again later.
    let attempt = job.state === 'idle' ? this.store.reserveRoot(job.id, `continue:${caller.clientId}:${input.requestId}`) : ({ kind: 'not_needed' } as const);
    if (attempt.kind === 'busy') {
      if (!key) this.store.releaseIdempotencyKey(caller.clientId, 'work_continue', input.requestId);
      throw rootBusy(job);
    }
    let sent;
    let sendIdentity: string | undefined;
    let sendGuardRejected = false;
    try {
      const client = this.#registry.client(job.hostId);
      if (attachments.length) {
        const uploaded = await client.uploadAttachments(attachments);
        await this.#validateAdoptedResume(this.store.require(job.id));
        const current = this.store.require(job.id);
        if (!['idle', 'running', 'needs_input'].includes(current.state)) {
          throw new GatewayError('job_state_conflict', `Job ${job.id} is ${current.state}; the attachment follow-up was not sent.`);
        }
        if (current.workspaceKind === 'root' && current.state === 'idle' &&
            (attempt.kind !== 'held' || !current.workspaceResumeTokens.includes(attempt.token) || current.workspaceRootHeldAt === null)) {
          attempt = this.store.reserveRoot(job.id, `continue:${caller.clientId}:${input.requestId}`);
          if (attempt.kind === 'busy') throw rootBusy(current);
        }
        // CAS is durable across processes. After this boundary, never resend without a downstream retry key.
        if (!this.store.beginAttachmentSend(caller.clientId, input.requestId)) throw attachmentOutcomeUnknown();
        const result = await client.sendAttachments(threadId, input.message, uploaded);
        sent = { ...result, delivery: 'accepted' };
      } else sent = await client.sendToThread({
        threadId,
        message: input.message,
        mode: 'auto',
        clientRequestId: `t3fg-${job.id}-${sha256Hex(`${caller.clientId}\n${input.requestId}`).slice(0, 24)}`,
      }, { beforeSend: (identity) => {
        try { this.store.beginTextSend(caller.clientId, input.requestId, identity, key === undefined); }
        catch (error) { sendGuardRejected = true; throw error; }
        sendIdentity = identity;
      } });
    } catch (error) {
      if (attachments.length && this.store.idempotencyKey(caller.clientId, 'work_continue', input.requestId)?.response !== null) {
        throw attachmentOutcomeUnknown();
      }
      if (sendGuardRejected) {
        if (attempt.kind === 'held') this.store.abandonResume(job.id, attempt.token);
        throw error;
      }
      if (attachments.length || error instanceof T3ToolError || (error instanceof T3TransportError && error.delivery === 'not_delivered')) {
        let released = false;
        if (!key) {
          if (sendIdentity === undefined) {
            this.store.releaseIdempotencyKey(caller.clientId, 'work_continue', input.requestId);
            released = true;
          } else released = this.store.releaseFirstTextSend(caller.clientId, input.requestId, sendIdentity);
        }
        // This attempt was refused or definitely undelivered; only its own reservation token ends here.
        if (attempt.kind === 'held') this.store.abandonResume(job.id, attempt.token);
        if (!released) {
          throw new GatewayError('t3_response_lost', 'A previous send attempt still has an uncertain outcome. Retry with the same requestId and T3 authorization, or inspect the thread.');
        }
        throw error;
      }
      const described = describeError(error);
      throw new GatewayError(
        described.code,
        `${described.message}. The message may or may not have reached T3: call work_continue again with the same requestId; T3 deduplicates it.`,
      );
    }
    this.store.recordSend(job.id, sent, caller.clientId, input.requestId, attempt.kind === 'held' ? attempt.token : undefined);
    this.wake();
    return { job: this.store.require(job.id), delivery: sent.delivery, replayed: false };
  }

  /** Answer one of the job's pending questions. Only requests T3 lists for the job's own thread are accepted. */
  async respond(caller: Caller, input: RespondInput): Promise<Job> {
    const job = this.#jobFor(caller, input.jobId, 'operate');
    this.#auditThread(caller, job, 'respond');
    if (job.threadId === null || isTerminal(job.state)) {
      throw new GatewayError('job_state_conflict', `Job ${job.id} is ${job.state}; it has no question to answer.`);
    }
    await this.#validateAdoptedResume(job);
    const client = this.#registry.client(job.hostId);
    const pending = await client.listPendingRequests(job.threadId);
    if (!pending.includes(input.requestId)) {
      const hint =
        pending.length > 0
          ? `Pending on this job: ${pending.join(', ')}.`
          : job.state === 'needs_input'
            ? 'The job is waiting for a permission approval, which only the operator can give in T3.'
            : 'The job has no pending questions.';
      throw new GatewayError('not_found', `That request is not pending on job ${job.id}. ${hint}`);
    }
    if (job.origin === 'adopted' && isTerminal(this.store.require(job.id).state)) {
      throw new GatewayError('job_state_conflict', 'The adopted job was released while its question was being checked. Nothing was sent.');
    }
    // An answer starts the worker again: an idle root job takes its folder back first (see continue).
    const attempt = job.state === 'idle' ? this.store.reserveRoot(job.id, `respond:${input.requestId}`) : ({ kind: 'not_needed' } as const);
    if (attempt.kind === 'busy') throw rootBusy(job);
    try {
      await client.respondToPendingRequest(job.threadId, input.requestId, input.answers);
    } catch (error) {
      if (attempt.kind === 'held' && (error instanceof T3ToolError || (error instanceof T3TransportError && error.delivery === 'not_delivered'))) {
        this.store.abandonResume(job.id, attempt.token);
      }
      throw error;
    }
    const remaining = pending.filter((id) => id !== input.requestId);
    this.store.appendEvent(job.id, 'input_answered', job.state, { requestId: input.requestId });
    const moved =
      remaining.length === 0 &&
      this.store.transition(job.id, { from: attempt.kind === 'held' ? ['needs_input', 'idle'] : ['needs_input'], to: 'running', changes: { pendingRequestIds: remaining }, detail: { reason: 'input_answered' } });
    if (!moved) {
      const waiting = attempt.kind === 'held' && remaining.length > 0 && this.store.transition(job.id, {
        from: ['idle'], to: 'needs_input', changes: { pendingRequestIds: remaining }, detail: { reason: 'question' },
      });
      if (!waiting) this.store.update(job.id, { pendingRequestIds: remaining });
    }
    if (attempt.kind === 'held') this.store.settleResume(job.id, attempt.token);
    this.wake();
    return this.store.require(job.id);
  }

  /**
   * Cancel a job. Queued jobs are cancelled without contacting T3. A job with a thread is
   * interrupted first and then recorded: cancelled at once if T3 reports nothing running, else
   * cancel_requested until the watcher sees the thread stop. If T3 cannot be reached, or the launch
   * is in flight or unconfirmed, the job becomes cancel_requested and the engine delivers the
   * interrupt later. A T3 refusal is returned and the job keeps its state.
   */
  async cancel(caller: Caller, input: { jobId: string }): Promise<CancelResult> {
    const job = this.#jobFor(caller, input.jobId, 'operate');
    this.#auditThread(caller, job, 'interrupt');
    if (job.standing) return this.#interruptStanding(job);
    if (job.state === 'queued') {
      const cancelled = this.store.transition(job.id, { from: ['queued'], to: 'cancelled', detail: { reason: 'cancelled_before_launch' } });
      return cancelled ? { job: cancelled, outcome: 'cancelled', delivered: true } : this.cancel(caller, input);
    }
    if (isTerminal(job.state)) return { job, outcome: job.state === 'cancelled' ? 'cancelled' : 'already_finished', delivered: true };
    const request = { from: ['dispatching', 'unknown', 'running', 'needs_input', 'idle'] as JobState[], to: 'cancel_requested' as const, detail: { reason: 'cancel_requested' } };
    if (job.threadId === null) {
      // The launch is in flight or unconfirmed: the engine interrupts the thread if it turns up.
      const requested = job.state === 'cancel_requested' ? job : this.store.transition(job.id, request);
      return requested ? { job: requested, outcome: 'cancel_requested', delivered: false } : this.cancel(caller, input);
    }
    let status: string;
    try {
      const client = this.#registry.client(job.hostId);
      // The interrupt's retry key names the run it stops, so learn which run is active first.
      const { thread } = await client.readThread({ threadId: job.threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 });
      const result = await client.interruptThread({
        threadId: job.threadId,
        clientRequestId: cancelRequestId(job.id, thread.activeRunId ?? thread.latestRunId),
        reason: 'Cancelled through t3-fleet-gateway',
      });
      status = result.status;
    } catch (error) {
      if (error instanceof T3ToolError) throw error;
      this.#logger.warn('jobs.interrupt_deferred', { jobId: job.id, errorCode: describeError(error).code });
      const requested = this.store.transition(job.id, request) ?? this.store.require(job.id);
      return { job: requested, outcome: requested.state === 'cancel_requested' ? 'cancel_requested' : 'already_finished', delivered: false };
    }
    const requested = this.store.transition(job.id, request) ?? this.store.require(job.id);
    if (requested.state !== 'cancel_requested') return { job: requested, outcome: requested.state === 'cancelled' ? 'cancelled' : 'already_finished', delivered: true };
    if (status !== 'interrupt_requested') {
      const cancelled = this.store.transition(job.id, { from: ['cancel_requested'], to: 'cancelled', detail: { reason: status } });
      return { job: cancelled ?? this.store.require(job.id), outcome: 'cancelled', delivered: true };
    }
    this.wake();
    return { job: requested, outcome: 'cancel_requested', delivered: true };
  }

  /**
   * work_cancel on a standing job: interrupt the run that is active now and leave the job open; the
   * watcher moves it to idle when T3 reports the run stopped. Nothing is deferred: if T3 cannot be
   * reached the agent is told to repeat the call, and a repeat for the same run reuses its T3
   * clientRequestId, which T3 deduplicates. When nothing is active no interrupt is sent: T3 would
   * answer a repeat for an already stopped run from its record of the first interrupt. The questions
   * T3 still lists for the thread are returned then: if T3 keeps a question after the interrupt, the job
   * stays needs_input (the watcher derives it from that list) until it is answered with work_respond;
   * once T3 lists none, the stopped thread is idle.
   */
  async #interruptStanding(job: Job): Promise<CancelResult> {
    if (isTerminal(job.state) || job.threadId === null) return { job, outcome: 'already_finished', delivered: true };
    const client = this.#registry.client(job.hostId);
    let status: string;
    try {
      const { thread } = await client.readThread({ threadId: job.threadId, view: 'messages', limit: 1, runLimit: 1, maxCharsPerItem: 1 });
      if (thread.activeRunId === null && !isActiveStatus(thread.status)) {
        // T3 may keep a question listed after its turn was interrupted; only an answer clears it.
        const pendingQuestionIds = await client.listPendingRequests(job.threadId);
        this.wake();
        return { job: this.store.require(job.id), outcome: 'not_running', delivered: true, pendingQuestionIds };
      }
      const result = await client.interruptThread({
        threadId: job.threadId,
        clientRequestId: cancelRequestId(job.id, thread.activeRunId ?? thread.latestRunId),
        reason: 'Interrupted through t3-fleet-gateway',
      });
      status = result.status;
    } catch (error) {
      if (error instanceof T3ToolError || !(error instanceof GatewayError)) throw error;
      throw new GatewayError(error.code, `${error.message}. The interrupt may not have reached T3: call work_cancel again; repeating it is safe.`);
    }
    if (status !== 'interrupt_requested') {
      this.wake();
      return { job: this.store.require(job.id), outcome: 'not_running', delivered: true };
    }
    const current = this.store.require(job.id);
    if (!isTerminal(current.state)) this.store.appendEvent(job.id, 'interrupt_requested', current.state, { reason: 'interrupt_requested' });
    this.wake();
    return { job: this.store.require(job.id), outcome: 'interrupt_requested', delivered: true };
  }

  /**
   * Events after `cursor` (exclusive) and the jobs needing attention. Cursors are global event ids; events of jobs
   * the agent may not see are filtered out before the limit, so they never take a place on its page.
   */
  feed(input: { cursor: number; limit: number; mine: boolean }, caller: Caller): Feed {
    const scope = this.#visible(caller, input.mine);
    const page = this.store.eventsAfter(input.cursor, input.limit + 1, scope);
    const events = page.slice(0, input.limit);
    return {
      events,
      nextCursor: events.at(-1)?.id ?? input.cursor,
      hasMore: page.length > input.limit,
      attention: this.store.attention(this.#clock(), ATTENTION_RECENT_MS, MAX_ATTENTION, scope),
    };
  }
}

/**
 * Read a thread to the end of its messages view, for adoption: the last page (or everything from the
 * first message that may still change, so a message being streamed is read again once settled) with the
 * thread's state. Bounded by MAX_ADOPT_PAGES; a longer thread is caught up by the watcher.
 */
async function readToEnd(client: T3Client, threadId: string): Promise<ThreadRead> {
  let afterPosition: number | null = null;
  let read: ThreadRead | undefined;
  let kept: ThreadItem[] = [];
  for (let page = 0; page < MAX_ADOPT_PAGES; page++) {
    read = await client.readThread({ threadId, view: 'messages', afterPosition, limit: 100, runLimit: 5, maxCharsPerItem: EXCERPT_CHARS });
    kept = kept.some(holdsReadPosition) ? [...kept, ...read.items] : read.items;
    if (!read.hasMore || read.nextPosition === null || read.nextPosition === afterPosition) break;
    afterPosition = read.nextPosition;
  }
  if (!read) throw new GatewayError('internal_error', 'No thread read');
  return { ...read, items: kept, nextPosition: read.nextPosition ?? afterPosition };
}

function attachmentOutcomeUnknown(): GatewayError {
  return new GatewayError('t3_response_lost', 'An attachment follow-up may have reached T3. It will not be resent: T3 has no attachment retry key. Read work_messages or inspect the thread before sending new work with a new requestId.');
}
