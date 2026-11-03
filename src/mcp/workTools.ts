import { attachmentsSchema } from '../jobs/attachments.ts';
import * as z from 'zod';
import { responseThreadIdSchema, threadIdSchema } from '../t3/threadId.ts';
import { displayPullRequests, MAX_PULL_REQUESTS, MAX_TRACKED_PULL_REQUESTS, pullRequestsSchema } from '../jobs/pullRequests.ts';
import { MAX_DELEGATED_TASKS } from '../jobs/derive.ts';
import { MAX_MESSAGE_TEXT_CHARS, MAX_MESSAGES } from '../jobs/messages.ts';
import {
  ATTENTION_RECENT_MS,
  MAX_ANSWERS_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_TASK_CHARS,
  MAX_TITLE_CHARS,
  MAX_QUESTION_READS,
  MAX_QUESTIONS,
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_CHARS,
  type QuestionRequest,
  REQUEST_ID_PATTERN,
  type JobService,
} from '../jobs/service.ts';
import { JOB_STATES, STATE_MEANINGS } from '../jobs/states.ts';
import { workspaceSelectionSchema } from '../jobs/workspace.ts';
import { MAX_SELECTION_CHARS, MAX_SELECTION_ID_CHARS, MAX_SELECTION_OPTIONS } from '../jobs/launchSpec.ts';
import type { FeedEvent, Job, JobEvent } from '../jobs/store.ts';
import { parseProjectRef } from '../jobs/targets.ts';
import { OPERATE_SCOPE, READ_SCOPE } from '../oauth/scopes.ts';
import { HOUR, isoTime } from '../time.ts';
import { defineTool, type GatewayTool, type ToolContext } from './tools.ts';

const MAX_LIST_LIMIT = 100;

const STATE_GUIDE = JOB_STATES.map((state) => `${state}: ${STATE_MEANINGS[state]}`).join(' ');

const time = z.string().describe('ISO 8601');
const nullableTime = time.nullable();

const MAX_FEED_LIMIT = 200;

const requestIdInput = z
  .string()
  .regex(REQUEST_ID_PATTERN, 'use 1-128 letters, digits, dots, underscores, colons or hyphens')
  .describe('Your unique id for this request, for safe retries (for example a UUID)');

// These opaque IDs belong to T3, whose real Codex IDs exceed 200 characters.
// Preserve them unchanged; job/request membership is checked live before responding.
const pendingRequestIdInput = z.string().min(1);

const jobIdInput = z
  .string()
  .regex(/^[0-9a-z]{6,32}$/, 'a job id as returned by work_start')
  .describe('The jobId returned by work_start, or listed by work_list or (for standing jobs) fleet_status');

// Strict: a field the gateway does not know (an option such as reasoningEffort beside `options`, say) is refused
// with no job, instead of being dropped and the job launched without what the agent asked for.
const targetInput = z.strictObject({
  host: z.string().min(1).max(32).describe('Host id'),
  projectId: z.string().min(1).max(200).describe('T3 project id from fleet_projects'),
});

const startTargetInput = z.strictObject({
  host: z.string().min(1).max(32).describe('Host id from fleet_status'),
  projectId: z.string().min(1).max(200).optional().describe('Explicit T3 project id from fleet_projects; omit for work with no named project'),
});

const modelSelectionInput = z
  .strictObject({
    instanceId: z.string().trim().min(1).max(MAX_SELECTION_ID_CHARS).describe('providerInstanceId from fleet_models'),
    model: z.string().trim().min(1).max(MAX_SELECTION_ID_CHARS).describe('modelId from fleet_models'),
    options: z
      .record(z.string().min(1).max(MAX_SELECTION_ID_CHARS), z.union([z.string().min(1).max(2000), z.boolean()]))
      .optional()
      .describe('Option id to value, inside this object: a choices[].id for a select option (a reasoning effort, say), true or false for a boolean option. Nothing else is accepted here'),
  })
  .refine((selection) => Object.keys(selection.options ?? {}).length <= MAX_SELECTION_OPTIONS && JSON.stringify(selection).length <= MAX_SELECTION_CHARS, {
    message: `at most ${MAX_SELECTION_OPTIONS} options and ${MAX_SELECTION_CHARS} characters`,
  });

const modelSourceSchema = z.enum(['explicit', 'project', 'host', 't3_default']);

const jobSchema = z.object({
  pullRequests: pullRequestsSchema
    .nullable()
    .describe(
      `Cached T3-linked PRs, at most ${MAX_PULL_REQUESTS} shown: open ones first, then the newest. The gateway follows up to ` +
        `${MAX_TRACKED_PULL_REQUESTS} per job, so older ones may be left out; the text summary says how many are followed. ` +
        'null means unknown, [] means none. PR states can lag T3/GitHub.',
    ),
  pullRequestsCheckedAt: nullableTime,
  jobId: z.string(),
  origin: z.enum(['gateway', 'standing', 'adopted']),
  adoptedBy: z.string().nullable(),
  adoptedAt: nullableTime,
  state: z.enum(JOB_STATES),
  project: z
    .string()
    .describe('The configured project alias, or for a job targeted by T3 project id without one, the internal ref @<host>/<projectId>'),
  host: z.string(),
  projectId: z.string().nullable().describe('The T3 project id: known from the start for targeted jobs, from dispatch for alias jobs'),
  projectName: z
    .string()
    .nullable()
    .describe('The T3 project title, recorded for jobs started with a discovered target or a modelSelection on a worktree alias; null for scratch jobs and when the stored launch plan could not be read'),
  source: z
    .enum(['alias', 'discovered'])
    .describe("alias: launched with a configured project's settings; discovered: into a T3 project no alias names, with the host's discovery policy"),
  model: z
    .object({
      source: modelSourceSchema.describe('explicit: your modelSelection; project or host: the gateway config; t3_default: the T3 project default'),
      selection: z.record(z.string(), z.unknown()).nullable().describe('The exact modelSelection sent to T3; null when T3 chose'),
    })
    .nullable()
    .describe(
      'Recorded for scratch, targeted or explicitly selected jobs; null for alias-only worktree jobs, whose model comes from the config at dispatch, ' +
        'and when the stored launch plan could not be read',
    ),
  title: z
    .string()
    .describe("The T3 thread title; a launched job's ends with the marker [job:<jobId>], a standing job's is the title the operator gave it"),
  workspaceMode: z
    .enum(['scratch', 'worktree', 'root'])
    .nullable()
    .describe(
      'scratch for T3 internal scratch; worktree for a fresh worktree on its own branch; root for the project\'s own folder (one root job per folder ' +
        'runs at a time); null when unknown: an adopted standing thread, a job on a host that chooses workspaces whose workspace is decided when it ' +
        'launches (still queued), or a job whose stored launch plan could not be read (a queued one then fails with database_error and is never ' +
        'launched; one with a thread carries on)',
    ),
  branch: z.string().describe("The git branch of the job worktree; empty for scratch or root work (a standing job: its thread's branch, or empty)"),
  standing: z
    .boolean()
    .describe(
      'true for a standing job: a long-lived T3 thread the operator registered (for example a coordinator), not one work_start ' +
        'launched. Send it work with work_continue; work_cancel only interrupts its current turn, and it stays open',
    ),
  waitingOnDelegatedWork: z
    .boolean()
    .describe(
      'true while work the thread delegated to other threads (T3 subagents) is still running, from T3\'s own status of that ' +
        'work. An idle job in this state resumes by itself when that work is done: do not send it new instructions, wait for ' +
        'its next turn. When this flag and the reply text disagree, trust the flag',
    ),
  delegatedTasks: z.array(z.string()).describe('Titles of the delegated work still running (see waitingOnDelegatedWork)'),
  delegatedTasksUntracked: z
    .int()
    .min(0)
    .describe(
      `Delegated tasks beyond the ${MAX_DELEGATED_TASKS} the gateway follows. While above 0, waitingOnDelegatedWork stays true ` +
        'until the job has run a new turn; ask the coordinator for status before sending more work',
    ),
  threadId: responseThreadIdSchema.nullable().describe('The T3 thread, once it exists'),
  link: z
    .string()
    .nullable()
    .describe('Opens the job thread in the T3 app: give it to the person when you mention the job. null until the thread exists'),
  createdAt: time,
  updatedAt: time.describe('When substantive job data last changed; freshness-only PR checks do not bump this'),
  stateChangedAt: time.describe('When the job entered its current state'),
  finishedAt: nullableTime,
  startedByYou: z.boolean(),
});

const eventSchema = z.object({
  cursor: z.string().describe('Feed position of this event'),
  jobId: z.string(),
  type: z.string().describe('created, state_changed, followup_sent, input_answered, turn_finished, delegated_work_ended, pull_request_opened, pull_request_merged or interrupt_requested'),
  fromState: z.enum(JOB_STATES).nullable(),
  toState: z.enum(JOB_STATES).nullable(),
  reason: z.string().nullable(),
  code: z.string().nullable(),
  at: time,
});

const positionInput = z.union([z.string().regex(/^\d{1,15}$/), z.int().min(0)]);

const errorSchema = z.object({ code: z.string(), message: z.string() });

const questionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string(), value: z.string().nullable() })),
  multiSelect: z.boolean().nullable().describe('null: T3 did not specify the selection rule'),
  allowCustomAnswer: z.boolean().nullable().describe('null: T3 did not specify whether custom text is allowed'),
  required: z.boolean().nullable().describe('null: T3 did not specify whether this answer is required'),
});

const jobDetailSchema = jobSchema.extend({
  settled: z.boolean().nullable().describe('Live T3 settlement state; null when unavailable or unsupported'),
  settledAt: nullableTime,
  stateMeaning: z.string(),
  pendingRequests: z
    .array(z.object({
      requestId: z.string(),
      questions: z.array(questionSchema).nullable(),
      questionsUnavailable: z.enum(['temporarily_unreadable', 'read_limit', 'too_large']).nullable()
        .describe('Why questions is null: retry, select pendingRequestId, or answer in T3 when too large'),
    }))
    .describe('Questions the worker is waiting on; answer with work_respond'),
  waitingForApproval: z.boolean().describe('Blocked on a permission approval that only the operator can give in T3'),
  latestMessageExcerpt: z.string().nullable().describe("The start of the worker's latest message, bounded"),
  excerptTruncated: z.boolean().describe('The excerpt stops short of the message: read it in full with work_messages'),
  latestActivityAt: nullableTime,
  hostUnreachableSince: nullableTime.describe('Set while the gateway cannot reach the host; the job state is kept'),
  lastError: errorSchema.nullable(),
  recentEvents: z.array(eventSchema),
});

const messageSchema = z.object({
  position: z.int().describe('Position in the thread; pass it as before or after to page from this message'),
  type: z.string().describe('assistant_message or proposed_plan'),
  status: z.string().describe('pending or running: still being written, read it again later'),
  updatedAt: z.string(),
  text: z.string(),
  textTruncated: z.boolean().describe('text is cut at maxChars'),
  length: z.int().nullable().describe('The full length in characters when text is all of it; null when it is cut'),
});

/** JSON quoting keeps arbitrary worker text and option values unambiguous for text-only clients. */
function questionText(request: QuestionRequest): string[] {
  const lines = [`Pending request: ${JSON.stringify(request.requestId)}`];
  if (request.questions === null) {
    const reason = request.questionsUnavailable === 'read_limit'
      ? 'Not read in this response (read limit). Call work_status with pendingRequestId set to this requestId.'
      : request.questionsUnavailable === 'too_large'
        ? `Question set exceeds ${MAX_QUESTIONS} questions, ${MAX_QUESTION_OPTIONS} options per question or ${MAX_QUESTION_CHARS} JSON characters. ` +
          'No partial questions returned. Ask the operator to answer this request in T3.'
        : 'Questions temporarily unreadable. Retry work_status; do not invent an answer.';
    lines.push(reason);
    return lines;
  }
  if (request.questions.length === 0) lines.push('T3 returned no questions. Recheck status before responding.');
  for (const question of request.questions) {
    lines.push(`Question: ${JSON.stringify(question)}`);
    const select = question.multiSelect === true ? 'Selection: an array of option values (labels when value is null).'
      : question.multiSelect === false ? 'Selection: a single option value (label when value is null).'
        : 'Selection rule unspecified by T3 (multiSelect is null): follow explicit question wording. ' +
          'Without instructions to select several, try a single listed value (label when value is null) as a conservative answer attempt, ' +
          'not a T3 default.';
    const custom = question.allowCustomAnswer === true ? 'Custom answers allowed: you may supply your own text.'
      : question.allowCustomAnswer === false ? 'Custom answers forbidden: use the listed options.' : 'Custom answers: unspecified by T3.';
    const required = question.required === true ? 'Answer required: include this question id.'
      : question.required === false ? 'Answer optional: this question id may be omitted.' : 'Required: unspecified by T3.';
    lines.push(`${select} ${custom} ${required}`);
  }
  return lines;
}

export type JobView = z.infer<typeof jobSchema>;
export type JobDetailView = z.infer<typeof jobDetailSchema>;

/** Where the job runs: what the dispatcher resolved, else what the spec says outright, else the worktree every other job gets. */
function workspaceModeOf(job: Job): JobView['workspaceMode'] {
  if (job.standing || job.launchSpecUnreadable) return null;
  const spec = job.launchSpec;
  if (spec?.v === 2) return spec.workspace.kind;
  if (spec?.v !== 3) return 'worktree';
  if (job.workspaceKind !== null) return job.workspaceKind;
  return spec.workspace.type === 'auto' ? null : spec.workspace.type;
}

export function jobView(job: Job, context: ToolContext): JobView {
  // A launch plan the gateway could not read leaves no spec: what only the spec said (project name, model, workspace) is left out,
  // and the workspace is unknown rather than assumed to be a worktree.
  const spec = job.launchSpec;
  return {
    // The tracked list is longer than a view may be: show the most relevant MAX_PULL_REQUESTS (describeJob says how many are followed).
    pullRequests: job.pullRequests === null ? null : displayPullRequests(job.pullRequests),
    pullRequestsCheckedAt: job.pullRequestsCheckedAt === null ? null : isoTime(job.pullRequestsCheckedAt),
    jobId: job.id,
    state: job.state,
    project: job.projectAlias,
    host: job.hostId,
    projectId: job.t3ProjectId,
    projectName: spec?.projectName ?? null,
    source: spec?.source ?? (parseProjectRef(job.projectAlias) ? 'discovered' : 'alias'),
    model: spec ? { source: spec.model.source, selection: spec.model.selection } : null,
    title: job.title,
    workspaceMode: workspaceModeOf(job),
    branch: job.branch,
    standing: job.standing,
    origin: job.origin,
    adoptedBy: job.adoptedBy,
    adoptedAt: job.adoptedAt === null ? null : isoTime(job.adoptedAt),
    waitingOnDelegatedWork: job.delegatedWork.length > 0 || job.delegatedUntracked > 0,
    delegatedTasks: job.delegatedWork.map((task) => task.title),
    delegatedTasksUntracked: job.delegatedUntracked,
    threadId: job.threadId,
    link: job.threadLink,
    createdAt: isoTime(job.createdAt),
    updatedAt: isoTime(job.updatedAt),
    stateChangedAt: isoTime(job.stateChangedAt),
    finishedAt: job.finishedAt === null ? null : isoTime(job.finishedAt),
    startedByYou: job.clientId === context.clientId,
  };
}

export function eventView(event: JobEvent): z.infer<typeof eventSchema> {
  return {
    cursor: String(event.id),
    jobId: event.jobId,
    type: event.type,
    fromState: event.fromState,
    toState: event.toState,
    reason: event.detail.reason ?? null,
    code: event.detail.code ?? null,
    at: isoTime(event.createdAt),
  };
}

/** One line about a job. The view lists at most MAX_PULL_REQUESTS PRs; the job knows how many the gateway follows, and the line says so. */
function describeJob(job: Job, view: JobView): string {
  const followed = job.pullRequests?.length ?? 0;
  // At the tracking bound the count is a floor: the thread may link more than the gateway follows.
  const count = `${followed}${followed >= MAX_TRACKED_PULL_REQUESTS ? '+' : ''}`;
  const prs = view.pullRequests === null ? 'PRs: unknown' : view.pullRequests.length === 0 ? 'PRs: none'
    : `PRs${followed > MAX_PULL_REQUESTS ? ` (${MAX_PULL_REQUESTS} of ${count} shown; open ones first, then the newest)` : ''}: ` +
      view.pullRequests.map((pr) => `${pr.repository}#${pr.number} ${pr.state ?? 'unknown'} ${pr.url}`).join(', ');
  const waiting = view.waitingOnDelegatedWork ? ', waiting on delegated work' : '';
  return `${view.jobId} [${view.state}${view.origin === 'adopted' ? ', adopted' : view.standing ? ', standing' : ''}${waiting}] ${view.project}: ${view.title} | ${prs} (checked ${view.pullRequestsCheckedAt ?? 'never'})`;
}

export function workTools(jobs: JobService): GatewayTool[] {
  const workAdopt = defineTool({
    name: 'work_adopt', title: 'Adopt an existing T3 thread', scope: OPERATE_SCOPE, readOnly: false,
    description: 'Import an existing external T3 thread as an adopted job, using host/projectId from fleet_projects and threadId from fleet_threads. ' +
      'Requires threads:read, threads:control, Operate on that host and discovery.enabled. Adoption only reads T3; it never sends or changes the thread. ' +
      'Use work_status/feed/messages/continue/respond/settle/cancel on the returned jobId. Cancel interrupts only the active turn. ' +
      'No launch slot is used. requestId deduplicates retries; adopting the same host/thread again returns its job. ' +
      'Threads already owned by a gateway launch or an operator standing job are refused. An operator can stop following with jobs release; a released adoption stays released.',
    inputSchema: z.object({ host: z.string().min(1).max(32), projectId: z.string().min(1).max(256),
      threadId: threadIdSchema, requestId: requestIdInput }),
    outputSchema: z.object({ job: jobSchema, created: z.boolean() }),
    async run(input, context) {
      const result = await jobs.adoptExternal(context, input);
      const view = jobView(result.job, context);
      return { structured: { job: view, created: result.created }, summary: `${result.created ? 'Adopted' : 'Already adopted'}: ${describeJob(result.job, view)}` };
    },
  });
  const workStart = defineTool({
    name: 'work_start',
    title: 'Start work',
    description:
      'Start work on a machine. When the user names no project, pass target { host } to use that machine’s configured T3 internal scratch workspace. ' +
      'When the user names a project, use its configured alias or explicit target { host, projectId }; project work creates a fresh git worktree and branch, unless the project\'s host chooses workspaces (see workspace below). ' +
      'An unknown named project must be resolved or reported, never treated as scratch. The gateway opens a T3 Code ' +
      'thread there and gives the worker your task and optional base64 image/file attachments. Returns at once with a jobId in state "queued"; the job moves to "running" ' +
      'when its host has a free slot. Follow it with work_feed (recommended: poll with the last cursor) or work_status. ' +
      'Idempotent: always pass a unique requestId per new piece of work; retrying with the same requestId and the same input ' +
      'returns the same job (created=false) instead of starting another, and reusing a requestId with different input is ' +
      'rejected (a changed target, model or options counts as different input). Request ids are scoped to this tool: one you also use with work_continue does not collide. Write the task as a complete instruction for a coding agent that cannot ask you anything mid-way except ' +
      'through questions you answer with work_respond. Pass exactly one of project (an alias from fleet_status) or target. ' +
      'target { host } needs only that host\'s defaultProject scratch alias (fleet_status shows it): no discovery is required. ' +
      'target { host, projectId } and an explicit modelSelection require a host whose discovery is enabled; a project ' +
      'without a configured alias also needs launch.allowed true there. A target that a configured alias maps to is launched as that ' +
      'alias, with all of its settings, so targeting by id never gets around a project\'s rules. Optionally pass modelSelection ' +
      '{ instanceId, model, options? } built from fleet_models of that host; it must match what the host advertises exactly ' +
      '(a wrong model, option or value is invalid_argument and nothing is started), and without it the configured defaults apply ' +
      '(project, then host, then the T3 project default). If fleet_status lists ' +
      'standingJobs for the project (a coordinator thread the operator runs), give the work to that job with work_continue ' +
      'instead of starting a new one; in a project with allowWorkStart false this tool fails with start_disabled and names them. ' +
      'workspace is optional, for named projects on a host whose operator configured a workspace probe (otherwise it is refused with invalid_argument): ' +
      'omit it, or pass { type: "auto" }, to get a fresh worktree from the up-to-date remote base for a Git repository, or the project\'s folder itself for any ' +
      'other folder; { type: "root" } works in the project\'s own folder (its checked-out branch, no new branch), and only one such job per folder runs ' +
      'at a time (the others wait queued, and a work_continue to an idle one is refused with workspace_root_busy while another holds the folder); ' +
      '{ type: "worktree", baseRef?, startFromOrigin? } insists on a fresh worktree. The choice is made when the job launches; its workspaceMode then shows it.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({
      project: z.string().min(1).max(64).optional().describe('Project alias from fleet_status (pass this or target)'),
      target: startTargetInput.optional().describe('Machine only for no named project, or machine and explicit project id (pass this or project)'),
      workspace: workspaceSelectionSchema.optional().describe('Omit for the host\'s automatic choice. { type: "root" } for the project\'s own folder; { type: "worktree", baseRef?, startFromOrigin? } for a fresh worktree. Only on hosts with a workspace probe'),
      modelSelection: modelSelectionInput.optional().describe('Explicit provider instance, model and options from fleet_models; omit for the configured defaults'),
      attachments: attachmentsSchema.optional(),
      task: z.string().min(1).max(MAX_TASK_CHARS).describe('What the worker should do, as a complete instruction'),
      requestId: requestIdInput,
      title: z.string().min(1).max(MAX_TITLE_CHARS).optional().describe('Short thread title; defaults to the first line of the task'),
    }),
    outputSchema: z.object({ job: jobSchema, created: z.boolean().describe('false when this requestId was already used: the existing job') }),
    async run(input, context) {
      const { job, created } = await jobs.start(context, input);
      const view = jobView(job, context);
      const prefix = created ? 'Started job' : 'Already started (same requestId):';
      return { structured: { job: view, created }, summary: `${prefix} ${describeJob(job, view)}. Poll work_feed or work_status for progress.` };
    },
  });

  const workList = defineTool({
    name: 'work_list',
    title: 'List jobs',
    description:
      'List jobs, newest first, optionally filtered by project alias, by target (host and T3 project id, for projects without an ' +
      'alias; a queued alias job has no project id yet), by state, or to the jobs you started. Use it to find a jobId ' +
      `or to see what is active. Read-only. States: ${STATE_GUIDE}`,
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({
      project: z.string().min(1).max(300).optional().describe('Only jobs in this project alias (or an internal @<host>/<projectId> ref as shown in job views)'),
      target: targetInput.optional().describe('Only jobs in this T3 project on this host'),
      states: z.array(z.enum(JOB_STATES)).max(JOB_STATES.length).optional().describe('Only jobs in these states'),
      mine: z.boolean().optional().describe('Only jobs started by this agent, plus standing jobs (which every agent drives)'),
      limit: z.int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Default 20, at most ${MAX_LIST_LIMIT}`),
    }),
    outputSchema: z.object({ jobs: z.array(jobSchema) }),
    async run(input, context) {
      const found = await jobs.list({ project: input.project, target: input.target, states: input.states, mine: input.mine, limit: input.limit ?? 20 }, context);
      const views = found.map((job) => jobView(job, context));
      const summary = views.length === 0 ? 'No matching jobs.' : found.map((job, i) => describeJob(job, views[i]!)).join('\n');
      return { structured: { jobs: views }, summary };
    },
  });

  const workStatus = defineTool({
    name: 'work_status',
    title: 'Job status',
    description:
      "Show one job in detail: state and what it means, the T3 thread, branch, timestamps, the worker's pending questions, " +
      "whether it waits for an operator approval, an excerpt of the worker's latest message (its own reply, never the summaries " +
      'of work it delegated; excerptTruncated true means it is cut short: read it in full with work_messages), whether it waits on work it delegated (waitingOnDelegatedWork, delegatedTasks, ' +
      'delegatedTasksUntracked), host reachability, the last error and recent events. Use it when work_feed reports a change ' +
      'on a job, before deciding to continue, respond or cancel: if waitingOnDelegatedWork is true, send nothing and wait for ' +
      'its next turn; the flag wins over the reply text when they disagree. ' +
      `Reads at most ${MAX_QUESTION_READS} pending requests by default; pass pendingRequestId to read another. ` +
      `Whole requests are bounded to ${MAX_QUESTIONS} questions, ${MAX_QUESTION_OPTIONS} options each and ${MAX_QUESTION_CHARS} JSON characters; ` +
      'questionsUnavailable explains any null questions. Text includes the questions and answer rules. ' +
      `Read-only. States: ${STATE_GUIDE}`,
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({
      jobId: jobIdInput,
      pendingRequestId: pendingRequestIdInput.optional().describe('Read this pending request instead of the first five; other ids stay listed'),
    }),
    outputSchema: jobDetailSchema,
    async run(input, context) {
      const detail = await jobs.status(context, input.jobId, input.pendingRequestId);
      const { job } = detail;
      const view: JobDetailView = {
        ...jobView(job, context),
        settled: detail.settled,
        settledAt: detail.settledAt,
        stateMeaning: STATE_MEANINGS[job.state],
        pendingRequests: detail.pendingRequests,
        waitingForApproval: detail.waitingForApproval,
        latestMessageExcerpt: job.latestMessageExcerpt,
        excerptTruncated: job.latestMessageExcerpt !== null && job.latestMessageTruncated,
        latestActivityAt: job.latestActivityAt === null ? null : isoTime(job.latestActivityAt),
        hostUnreachableSince: job.hostUnreachableSince === null ? null : isoTime(job.hostUnreachableSince),
        lastError: job.lastErrorCode === null ? null : { code: job.lastErrorCode, message: job.lastErrorMessage ?? '' },
        recentEvents: detail.recentEvents.map(eventView),
      };
      const lines = [describeJob(job, view), STATE_MEANINGS[job.state]];
      lines.push(`Thread settled: ${view.settled === null ? 'unknown' : view.settled}${view.settledAt ? ` at ${view.settledAt}` : ''}.`);
      if (view.link) lines.push(`Open in T3: ${view.link}`);
      if (view.pendingRequests.length > 0) {
        lines.push(`Answer with work_respond using jobId ${JSON.stringify(view.jobId)}, the requestId and answers keyed by question id. ` +
          `At most ${MAX_QUESTIONS} answers, question ids at most 200 characters, answers JSON at most ${MAX_ANSWERS_CHARS} characters. ` +
          'Use an option value, or its label when value is null. Follow explicit question wording; unspecified flags alone do not block ' +
          'an answer or require escalation. T3 validates answers; do not retry blindly if delivery is uncertain.');
        for (const request of view.pendingRequests) lines.push(...questionText(request));
      }
      if (view.waitingForApproval) lines.push('Waiting for an approval the operator must give in T3.');
      if (view.hostUnreachableSince) lines.push(`Host unreachable since ${view.hostUnreachableSince}.`);
      if (view.waitingOnDelegatedWork) {
        lines.push(`Waiting on delegated work (${delegatedSummary(job, Infinity)}); it resumes by itself. Do not send new instructions.`);
      } else if (job.delegatedEndedAt !== null) {
        lines.push(DELEGATED_ENDED);
      }
      if (view.lastError) lines.push(`Last error: ${view.lastError.code}`);
      if (view.latestMessageExcerpt) {
        const cut = view.excerptTruncated ? '; it is cut short, read it in full with work_messages' : '';
        lines.push(`Latest worker message (excerpt${cut}):\n${view.latestMessageExcerpt}`);
      }
      return { structured: view, summary: lines.join('\n') };
    },
  });

  const workMessages = defineTool({
    name: 'work_messages',
    title: 'Read worker messages',
    description:
      "Read a job's worker messages in full, live from T3: the worker's own replies (assistant messages and proposed plans), " +
      'never the messages sent to it, its tool activity or the summaries of work it delegated. Use it to read a reply when ' +
      'work_status shows excerptTruncated true, after work_feed reports a finished turn, or to read earlier replies. Without ' +
      `before or after it returns the latest messages (limit, default 1, at most ${MAX_MESSAGES}), oldest first. Page back with ` +
      'before set to the returned earlier; read newer messages with after set to the returned later (hasMore: more wait in the ' +
      `direction you read). Each message has textTruncated and length: text is cut at maxChars (default and at most ` +
      `${MAX_MESSAGE_TEXT_CHARS}); length is the full length, null when cut. A message with status pending or running is still ` +
      'being written: later stops before it, so reading on with after returns it again once finished. Read-only.',
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({
      jobId: jobIdInput,
      before: positionInput.optional().describe('Only messages before this position (exclusive): earlier from a previous call'),
      after: positionInput.optional().describe('Only messages after this position (exclusive): later from a previous call'),
      limit: z.int().min(1).max(MAX_MESSAGES).optional().describe(`Messages to return, default 1, at most ${MAX_MESSAGES}`),
      maxChars: z
        .int()
        .min(1)
        .max(MAX_MESSAGE_TEXT_CHARS)
        .optional()
        .describe(`Characters of text per message, default and at most ${MAX_MESSAGE_TEXT_CHARS}`),
    }),
    outputSchema: z.object({
      job: jobSchema,
      messages: z.array(messageSchema).describe('Oldest first'),
      earlier: z.int().nullable().describe('Pass as before for older messages; null when there are none'),
      later: z.int().nullable().describe('Pass as after for newer messages'),
      hasMore: z.boolean().describe('More messages wait in the direction you read: older ones, or newer ones with after'),
    }),
    async run(input, context) {
      const { job, page } = await jobs.messages(context, input.jobId, {
        before: input.before === undefined ? undefined : Number(input.before),
        after: input.after === undefined ? undefined : Number(input.after),
        limit: input.limit ?? 1,
        maxChars: input.maxChars ?? MAX_MESSAGE_TEXT_CHARS,
      });
      const view = jobView(job, context);
      const messages = page.messages.map(({ itemId: _itemId, ...message }) => message);
      const lines = [
        `${describeJob(job, view)}: ${messages.length} worker message(s), oldest first; earlier ${page.earlier ?? 'none'}, later ${page.later ?? 'none'}` +
          `${page.hasMore ? ', more waiting' : ''}.`,
        ...messages.map((message) => {
          const size = message.length === null ? `cut at ${message.text.length} characters` : `${message.length} characters`;
          return `#${message.position} ${message.type} (${message.status}, ${size}):\n${message.text}`;
        }),
      ];
      return { structured: { job: view, messages, earlier: page.earlier, later: page.later, hasMore: page.hasMore }, summary: lines.join('\n\n') };
    },
  });

  const workFeed = defineTool({
    name: 'work_feed',
    title: 'Job feed',
    description:
      'What changed since you last looked, plus the jobs that need you now. Designed for a scheduled routine: call it with ' +
      'the nextCursor from your previous call (omit cursor the first time), handle the events, store the new nextCursor, ' +
      'and call again with it while hasMore is true. The cursor is exclusive, so no event is returned twice. Events: ' +
      'created, state_changed (fromState to toState, with a reason), followup_sent, input_answered, turn_finished (an idle ' +
      'job ran a whole turn you did not start, between two checks), delegated_work_ended (an idle job\'s delegated work ' +
      'finished, failed or was cancelled and it did not resume: send work_continue asking it to check on that work), ' +
      'pull_request_opened or pull_request_merged (cached linked PR changes: read work_status for references), ' +
      'job_recovered (a failed worker turn resumed in T3 or through work_continue), ' +
      'interrupt_requested (work_cancel on a standing job). A ' +
      'turn you did not start shows as state_changed idle to running with reason turn_started (or as turn_finished): a person ' +
      'typed in T3, or a coordinator resumed after work it delegated finished. Standing jobs (long-lived threads the operator ' +
      'registered) report here like any job, so this is also how you follow a coordinator you send work to with work_continue. ' +
      'A coordinator goes idle while work it delegated runs (reason waiting_on_delegated_work, waitingOnDelegatedWork true) and ' +
      'resumes by itself: wait for its next turn instead of sending new instructions, even if its reply reads otherwise. ' +
      '"attention" lists jobs in needs_input (answer with work_respond, or the operator must approve in T3) or unknown ' +
      '(the gateway is confirming the launch) at any age, and jobs that went idle or failed, or whose delegated work ended, ' +
      `within the last ${ATTENTION_RECENT_MS / HOUR} hours, each with "why": what to do next. An idle job is not proof the task ` +
      'succeeded. Read-only.',
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: z.object({
      cursor: z
        .union([z.string().regex(/^\d{1,15}$/), z.int().min(0)])
        .optional()
        .describe('nextCursor from your previous work_feed call; omit to start from the beginning'),
      limit: z.int().min(1).max(MAX_FEED_LIMIT).optional().describe(`Events per page, default 50, at most ${MAX_FEED_LIMIT}`),
      mine: z
        .boolean()
        .optional()
        .describe('Only events and jobs from work this agent started, plus standing jobs (which no agent starts but every agent drives)'),
    }),
    outputSchema: z.object({
      events: z.array(eventSchema.extend({
        project: z.string(),
        title: z.string(),
        host: z.string(),
        projectId: z.string().nullable().describe('The T3 project id, once the job knows it'),
      })),
      nextCursor: z.string().describe('Pass this as cursor next time'),
      hasMore: z.boolean().describe('More events are waiting: call again with nextCursor'),
      attention: z.array(jobSchema.extend({ why: z.string() })),
    }),
    async run(input, context) {
      const feed = jobs.feed({ cursor: Number(input.cursor ?? 0), limit: input.limit ?? 50, mine: input.mine ?? false }, context);
      const events = feed.events.map((event: FeedEvent) => ({ ...eventView(event), project: event.projectAlias, title: event.title, host: event.hostId, projectId: event.t3ProjectId }));
      const attention = feed.attention.map((job) => ({ ...jobView(job, context), why: attentionReason(job) }));
      const lines = [
        `${events.length} event(s)${feed.hasMore ? ', more waiting' : ''}; nextCursor ${feed.nextCursor}.`,
        ...events.map((event) => `#${event.cursor} ${event.jobId} ${event.type}${event.toState ? ` -> ${event.toState}` : ''}${event.reason ? ` (${event.reason})` : ''}`),
        attention.length === 0 ? 'Nothing needs attention.' : 'Needs attention:',
        ...attention.map((job) => `${job.jobId} [${job.state}] ${job.title}: ${job.why}`),
      ];
      return { structured: { events, nextCursor: String(feed.nextCursor), hasMore: feed.hasMore, attention }, summary: lines.join('\n') };
    },
  });

  const workContinue = defineTool({
    name: 'work_continue',
    title: 'Continue a job',
    description:
      "Send a follow-up instruction to a job's T3 thread: review feedback, the next step, or a correction. Use it when the " +
      'job is idle (its turn finished; this starts a new turn and the job goes back to running). On a running or needs_input ' +
      'job T3 steers the active turn or queues the message behind it. This is also how you give work to a standing job ' +
      '(standing: true, for example a coordinator thread the operator registered; fleet_status lists them per project): send ' +
      'it the instruction here, then follow it with work_feed and work_status. A coordinator goes idle while work it delegated ' +
      'runs and resumes by itself when that is done: before sending, check work_status. If waitingOnDelegatedWork is true, do ' +
      'not send (a message would start a competing turn), whatever the reply says; wait for its next turn in work_feed. If it ' +
      'is false, nothing it delegated is still running: send follow-ups when its reply asks for input or the work is done, or ' +
      'when work_feed reports delegated_work_ended (its delegated work ended but it did not resume: ask it to check on that work). ' +
      'On a settled idle job, sending resumes the thread and T3 clears settlement. Terminal jobs cannot be continued. ' +
      'Optional attachments send base64 images or files through T3 host storage, outside the repository. ' +
      'Idempotent: pass a unique requestId per message; ' +
      'repeating a requestId returns the first result without sending again, and if a call fails with an uncertain outcome, ' +
      'repeating it with the same requestId is safe. Attachment sends have no downstream retry key: an uncertain send stays blocked, ' +
      'so inspect work_messages or the thread before using a new requestId. Request ids are scoped to this tool, separate from work_start. Not for answering a pending question: use work_respond.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({
      jobId: jobIdInput,
      attachments: attachmentsSchema.optional(),
      message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe('The instruction for the worker'),
      requestId: requestIdInput,
    }),
    outputSchema: z.object({
      job: jobSchema,
      delivery: z.string().describe('started (new turn), steered (active turn), queued (behind it), or accepted (attachments: T3 does not report delivery mode)'),
      replayed: z.boolean().describe('true when this requestId was already delivered; nothing was sent again'),
    }),
    async run(input, context) {
      const result = await jobs.continue(context, input);
      const view = jobView(result.job, context);
      const summary = `${result.replayed ? 'Already sent (same requestId)' : 'Sent'}: ${result.delivery}. ${describeJob(result.job, view)}`;
      return { structured: { job: view, delivery: result.delivery, replayed: result.replayed }, summary };
    },
  });

  const workRespond = defineTool({
    name: 'work_respond',
    title: 'Answer a question',
    description:
      'Answer a question the worker asked: the job is needs_input and work_status lists it under pendingRequests with its ' +
      'questions. Pass that requestId and an answers object keyed by question id; each value is the chosen option ' +
      "(its value, or its label when it has no value), an array of them for multiSelect questions, or your own text when " +
      'custom answers are allowed. Only requests pending on this job are accepted. Permission approvals cannot be answered ' +
      'here: when work_status shows waitingForApproval, the operator must approve in T3 (projects that should run unattended ' +
      'use runtimeMode auto or full-access; fleet_status shows each project\'s mode). Not idempotent: if a call fails with an ' +
      'uncertain outcome (a timeout or lost response), call work_status before retrying; if the requestId is no longer ' +
      'listed under pendingRequests, the answer arrived.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({
      jobId: jobIdInput,
      requestId: pendingRequestIdInput.describe('A pendingRequests[].requestId from work_status, passed unchanged'),
      answers: z
        .record(z.string().max(200), z.unknown())
        .refine((answers) => Object.keys(answers).length <= MAX_QUESTIONS && JSON.stringify(answers).length <= MAX_ANSWERS_CHARS, {
          message: `at most ${MAX_QUESTIONS} answers and ${MAX_ANSWERS_CHARS} characters`,
        })
        .describe('Answers keyed by question id'),
    }),
    outputSchema: z.object({ job: jobSchema }),
    async run(input, context) {
      const job = await jobs.respond(context, input);
      const view = jobView(job, context);
      return { structured: { job: view }, summary: `Answered ${input.requestId}. ${describeJob(job, view)}` };
    },
  });

  const workCancel = defineTool({
    name: 'work_cancel',
    title: 'Cancel a job',
    description:
      "Stop a job. A queued job is cancelled at once without touching T3. Otherwise the gateway asks T3 to interrupt the " +
      'thread: outcome "cancelled" means it is confirmed stopped; "cancel_requested" means the interrupt is requested ' +
      '(delivered=true) or will be delivered when the host is reachable or the launch is confirmed (delivered=false), and ' +
      'the job moves to cancelled when the watcher sees the thread stop. Cancelled is terminal; the T3 thread and its ' +
      'worktree stay for the operator. A standing job (standing: true) is never closed by this tool: only its current turn ' +
      'is interrupted, which may be a turn the operator started in the T3 app. Outcome "interrupt_requested" means T3 is ' +
      'stopping the turn and the job returns to idle (still open, ready for work_continue) once it has stopped; ' +
      '"not_running" means nothing was running. Interrupting does not withdraw a question the worker asked: if T3 still ' +
      'lists it (pendingQuestions), the job stays needs_input until you answer it with work_respond. Safe to repeat.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({ jobId: jobIdInput }),
    outputSchema: z.object({
      job: jobSchema,
      outcome: z.enum(['cancelled', 'cancel_requested', 'already_finished', 'interrupt_requested', 'not_running']),
      confirmed: z.boolean().describe('The job is stopped (a standing job: nothing is running on it)'),
      delivered: z.boolean().describe('T3 has the interrupt request, or none was needed'),
      pendingQuestions: z
        .array(z.string())
        .describe('Standing job with nothing running: questions T3 still lists for it. They need an answer with work_respond'),
    }),
    async run(input, context) {
      const result = await jobs.cancel(context, input);
      const view = jobView(result.job, context);
      // A standing job is never closed: confirmed means its turn is not running.
      const confirmed = view.standing ? result.outcome !== 'interrupt_requested' : ['cancelled', 'failed', 'released'].includes(view.state);
      const summaries: Record<typeof result.outcome, string> = {
        cancel_requested: `Cancel requested${result.delivered ? '' : ' (will be delivered when possible)'}; waiting for T3 to confirm.`,
        cancelled: 'Cancelled.',
        already_finished: 'Already finished.',
        interrupt_requested: 'Interrupt requested; the standing job stays open and becomes idle once the turn has stopped.',
        not_running: 'Nothing was running; the standing job stays open.',
      };
      const pendingQuestions = result.pendingQuestionIds ?? [];
      const pending =
        pendingQuestions.length > 0
          ? ` The worker's question is still pending (${pendingQuestions.join(', ')}): read it with work_status and answer with work_respond; ` +
            'the job stays needs_input until then.'
          : '';
      const summary = `${summaries[result.outcome]}${pending} ${describeJob(result.job, view)}`;
      return { structured: { job: view, outcome: result.outcome, confirmed, delivered: result.delivered, pendingQuestions }, summary };
    },
  });

  const workSettle = defineTool({
    name: 'work_settle',
    title: 'Settle a finished thread',
    description: "Settle an idle, cancelled, failed or released job's T3 thread after delegated work ends. " +
      'Checks fresh T3 state; T3 refuses running turns, queued user messages and blocking approvals/questions. ' +
      'Clears the pin, ends PR watches and detaches provider sessions; does not archive or change the job state. ' +
      'Use a unique requestId per settlement. Replays return the confirmed result, never settle a resumed thread again. ' +
      'An uncertain outcome is read back without re-sending. work_status reports current settlement; ' +
      'work_continue on a settled idle job resumes it and clears settlement.',
    scope: OPERATE_SCOPE,
    readOnly: false,
    inputSchema: z.object({ jobId: jobIdInput, requestId: requestIdInput }),
    outputSchema: z.object({ job: jobSchema, settled: z.boolean(), settledAt: nullableTime, replayed: z.boolean() }),
    async run(input, context) {
      const result = await jobs.settle(context, input);
      return {
        structured: { ...result, job: jobView(result.job, context) },
        summary: `${result.replayed ? 'Already confirmed (same requestId)' : 'Confirmed'}: thread settled. Job state: ${result.job.state}.`,
      };
    },
  });

  return [workStart, workAdopt, workContinue, workRespond, workCancel, workSettle, workStatus, workMessages, workList, workFeed];
}

const DELEGATED_ENDED =
  'Its delegated work has ended (finished, failed or cancelled) but it did not resume. Send work_continue asking it to check on that work.';

/**
 * The delegated tasks for a one-line reason: the first `shown` titles, then how many more, and the
 * tasks beyond those followed, if any.
 */
function delegatedSummary(job: Job, shown = 3): string {
  const titles = job.delegatedWork.map((task) => `"${task.title}"`);
  const listed = titles.length > shown ? `${titles.slice(0, shown).join(', ')} and ${titles.length - shown} more` : titles.join(', ');
  if (job.delegatedUntracked === 0) return listed;
  const total = job.delegatedWork.length + job.delegatedUntracked;
  const untracked = `following ${job.delegatedWork.length} of ${total} delegated tasks; ask the coordinator for status before sending more work`;
  return listed ? `${listed}; ${untracked}` : untracked;
}

function attentionReason(job: Job): string {
  switch (job.state) {
    case 'needs_input':
      return job.pendingRequestIds.length > 0
        ? 'The worker asked a question: read it with work_status and answer with work_respond.'
        : 'The worker waits for a permission approval that only the operator can give in T3.';
    case 'unknown':
      return 'The launch outcome is unconfirmed; the gateway is checking T3. Do not start a duplicate yet.';
    case 'idle': {
      if (job.delegatedWork.length > 0 || job.delegatedUntracked > 0) {
        return (
          `Waiting on work it delegated (${delegatedSummary(job)}). It resumes by itself when that is done: do not send new ` +
          'instructions; wait for its next turn in work_feed.'
        );
      }
      if (job.lastErrorCode === 't3_run_failed') return 'The worker\'s last run failed; see lastError. Resume in T3 or use work_continue to retry on the same thread.';
      if (job.delegatedEndedAt !== null) return DELEGATED_ENDED;
      if (!job.standing) return 'Turn finished: read the reply with work_messages (work_status has an excerpt), then work_continue or work_cancel.';
      return (
        `Standing job's turn ended: read its reply with work_messages (work_status has an excerpt). Nothing it delegated is still running ` +
        '(waitingOnDelegatedWork is false, which wins over the reply text). Send work_continue when the reply asks for input ' +
        'or the work is done.'
      );
    }
    case 'failed':
      return 'Failed: see lastError in work_status. Start a new job to retry.';
    default:
      return STATE_MEANINGS[job.state];
  }
}
