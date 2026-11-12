import * as z from 'zod';
import { responseThreadIdSchema } from '../t3/threadId.ts';
import type { GatewayServices } from '../gateway.ts';
import type { CatalogThread } from '../hosts/threads.ts';
import type { Snapshot } from '../hosts/catalog.ts';
import { GatewayError } from '../errors.ts';
import { permits, READ_SCOPE, THREAD_READ_SCOPE } from '../oauth/scopes.ts';
import { isoTime } from '../time.ts';
import { MAX_LIVENESS_IDS, MAX_LIVENESS_READS } from '../hosts/liveness.ts';
import { defineTool } from './tools.ts';

export function threadTools(deps: GatewayServices) {
  return [defineTool({
    name: 'fleet_threads', title: 'Discover existing T3 threads', scope: READ_SCOPE, readOnly: true,
    description: 'List threads in one T3 project, including work started directly in T3. Requires threads:read plus Read on the host, ' +
      'and discovery.enabled. Use host and projectId from fleet_projects. Read-only: no adoption or control. ' +
      'Pages default to 50 (max 100); pass nextCursor as cursor. Cached for 30 seconds; refresh replaces the snapshot and invalidates its cursors. ' +
      'Catalogs over 2,000 threads are catalog_limit, never cut. T3 excludes archived/deleted threads and delegated child threads are omitted. ' +
      'lastActivityAt is T3 updatedAt (including metadata changes); archived is null when T3 does not report it. ' +
      'gatewayOwned means a gateway launch; jobId/origin also identify adopted and operator standing jobs. Use work_adopt to import an external thread.',
    inputSchema: z.object({ host: z.string().min(1).max(32), projectId: z.string().min(1).max(256),
      limit: z.int().min(1).max(100).optional(), cursor: z.string().min(1).max(2048).optional(), refresh: z.boolean().optional() }),
    outputSchema: z.object({ host: z.string(), projectId: z.string(), readAt: z.string(), total: z.int(), nextCursor: z.string().nullable(),
      threads: z.array(z.object({ threadId: responseThreadIdSchema, title: z.string(), state: z.string(), lastActivityAt: z.string().nullable(),
        settled: z.boolean().nullable(), settledAt: z.string().nullable(), archived: z.boolean().nullable(),
        gatewayOwned: z.boolean(), jobId: z.string().nullable(), origin: z.enum(['gateway', 'standing', 'adopted']).nullable() })) }),
    async run(input, caller) {
      if (!caller.scopes.includes(THREAD_READ_SCOPE)) throw new GatewayError('insufficient_scope', 'fleet_threads requires threads:read. Ask the operator to use clients grant.');
      const host = deps.config.hosts.find((candidate) => candidate.id === input.host);
      if (!host || !permits(caller.scopes, 'read', host.id)) throw new GatewayError('not_found', 'No host with that id. Use fleet_status.');
      await deps.jobs.authorizeProject(caller, host.id, input.projectId);
      if (!host.discovery.enabled) throw new GatewayError('discovery_disabled', 'Thread discovery needs discovery.enabled on this host.');
      if (input.cursor && input.refresh) throw new GatewayError('invalid_argument', 'Pass refresh or cursor, not both.');
      let snapshot: Snapshot<CatalogThread[]>;
      let offset = 0;
      if (input.cursor) {
        let decoded: unknown;
        try { decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { /* Refused below. */ }
        const parsed = z.tuple([z.literal('threads-v1'), z.string(), z.string(), z.string(), z.int().min(0)]).safeParse(decoded);
        const held = deps.threads.held(host.id, input.projectId);
        if (!parsed.success || parsed.data[1] !== host.id || parsed.data[2] !== input.projectId || !held || parsed.data[3] !== held.id || parsed.data[4] > held.value.length) {
          throw new GatewayError('invalid_argument', 'That thread cursor is invalid or its snapshot was replaced. Start again without cursor.');
        }
        snapshot = held;
        offset = parsed.data[4];
      } else {
        // Same host/project discovery rules as fleet_projects, before any thread cache or T3 thread access.
        const projects = await deps.catalog.projects(host.id, { refresh: input.refresh === true });
        if (!projects.value.some((project) => project.id === input.projectId)) throw new GatewayError('not_found', 'No project with that id on this host.');
        snapshot = await deps.threads.read(host.id, input.projectId, input.refresh);
      }
      const threads = snapshot.value.slice(offset, offset + (input.limit ?? 50)).map((thread) => {
        // Ownership is current ledger state, never part of the cached T3 snapshot.
        const job = deps.jobs.store.jobForThread(host.id, thread.threadId, { projects: deps.jobs.projectAccess(caller) });
        return { ...thread, gatewayOwned: job?.origin === 'gateway', jobId: job?.id ?? null, origin: job?.origin ?? null };
      });
      const end = offset + threads.length;
      const nextCursor = end < snapshot.value.length
        ? Buffer.from(JSON.stringify(['threads-v1', host.id, input.projectId, snapshot.id, end])).toString('base64url') : null;
      const structured = { host: host.id, projectId: input.projectId, readAt: isoTime(snapshot.fetchedAt), total: snapshot.value.length, nextCursor, threads };
      return { structured, summary: `${structured.total} T3 thread(s); read ${structured.readAt}.` +
        threads.map((thread) => `\n${thread.threadId} [${thread.state}${thread.origin ? `, ${thread.origin}, job ${thread.jobId}` : ', external'}] ${JSON.stringify(thread.title)}`).join('') +
        (nextCursor ? `\nMore: cursor ${nextCursor}` : '') };
    },
  }), defineTool({
    name: 'fleet_thread_liveness', title: 'Read T3 thread liveness', scope: READ_SCOPE, readOnly: true,
    description: 'Whether each live thread in one T3 project is working, waiting (on a question, an approval, an unclassified request ' +
      'or a delegated child), has ended its turn, or is idle, with its own last provider activity. Requires threads:read plus Read on ' +
      'the host, and discovery.enabled. Covers non-settled threads including delegated children and threads started directly in T3; ' +
      'a thread is read in detail when it is active or waiting, its latest change is within withinHours (default 24), or it is named in ' +
      `threadIds (at most ${MAX_LIVENESS_IDS}; for example a tracked thread that has since been settled). At most ${MAX_LIVENESS_READS} ` +
      'detailed reads; beyond that, or when a page or thread cannot be read, complete is false and errors say why: never read an ' +
      'incomplete report as "nothing running". lastActivityAt is the newest own-thread provider activity (output, reasoning, commands, ' +
      'tools, file changes) in the active or latest run, else that run\'s start; it never includes metadata changes, user messages or ' +
      'this read. activityComplete false (error activity_partial) means the bounded read could not see the whole current run or every delegated child, so ' +
      'lastActivityAt, openItems and delegatedActive are lower bounds and an ended or idle phase is not final. model and provider are the thread\'s model id and provider instance as T3 shows them (null when T3 gives none). Returns no message text, commands or answers. Read-only: it never sends, answers, settles, adopts or watches, and ' +
      'never marks a child result delivered. Cached for 30 seconds.',
    inputSchema: z.object({ host: z.string().min(1).max(32), projectId: z.string().min(1).max(256),
      threadIds: z.array(z.string().min(1).max(2048)).max(MAX_LIVENESS_IDS).optional(), withinHours: z.int().min(1).max(168).optional() }),
    outputSchema: z.object({
      host: z.string(), projectId: z.string(), environmentId: z.string().nullable(), readAt: z.string(), complete: z.boolean(),
      listed: z.int(), considered: z.int(), omitted: z.int(),
      threads: z.array(z.object({
        threadId: responseThreadIdSchema, link: z.string().nullable(), parentThreadId: z.string().nullable(), title: z.string(),
        status: z.string(), phase: z.enum(['working', 'waiting', 'turn_ended', 'idle']),
        waitingOn: z.enum(['question', 'approval', 'request', 'child']).nullable(), activeRunId: z.string().nullable(),
        latestRun: z.object({ runId: z.string(), ordinal: z.int(), status: z.string(), requestedAt: z.string().nullable(),
          startedAt: z.string().nullable(), completedAt: z.string().nullable() }).nullable(),
        createdAt: z.string().nullable(), metadataUpdatedAt: z.string().nullable(), observedAt: z.string(),
        settled: z.boolean().nullable(), archived: z.boolean().nullable(), snoozedUntil: z.string().nullable(),
        lastActivityAt: z.string().nullable(), activitySource: z.enum(['timeline', 'run_start', 'none']), activityComplete: z.boolean(),
        openItems: z.int(), delegatedActive: z.int(), pendingQuestions: z.int(), pendingRequests: z.int(),
        approval: z.enum(['confirmed', 'unclassified', 'none']),
        pullRequests: z.array(z.object({ url: z.string(), repository: z.string().nullable(), number: z.int().nullable(), state: z.string().nullable() })),
        model: z.string().nullable(), provider: z.string().nullable(),
      })),
      errors: z.array(z.object({ threadId: z.string().nullable(), code: z.string() })),
    }),
    async run(input, caller) {
      if (!caller.scopes.includes(THREAD_READ_SCOPE)) throw new GatewayError('insufficient_scope', 'fleet_thread_liveness requires threads:read. Ask the operator to use clients grant.');
      const host = deps.config.hosts.find((candidate) => candidate.id === input.host);
      if (!host || !permits(caller.scopes, 'read', host.id)) throw new GatewayError('not_found', 'No host with that id. Use fleet_status.');
      await deps.jobs.authorizeProject(caller, host.id, input.projectId);
      if (!host.discovery.enabled) throw new GatewayError('discovery_disabled', 'Thread liveness needs discovery.enabled on this host.');
      // Same discovery rules as fleet_threads, before any liveness cache or T3 thread access.
      const projects = await deps.catalog.projects(host.id);
      if (!projects.value.some((project) => project.id === input.projectId)) throw new GatewayError('not_found', 'No project with that id on this host.');
      const snapshot = await deps.liveness.read(host.id, input.projectId, { threadIds: input.threadIds ?? [], withinHours: input.withinHours ?? 24 });
      const report = snapshot.value;
      const counts = new Map<string, number>();
      for (const thread of report.threads) counts.set(thread.phase, (counts.get(thread.phase) ?? 0) + 1);
      return { structured: report, summary: `${report.threads.length} thread(s) read of ${report.considered} considered, ${report.listed} non-settled; ` +
        `${[...counts].map(([phase, n]) => `${n} ${phase}`).join(', ') || 'none live'}; ${report.complete ? 'complete' : `INCOMPLETE (${report.errors.map((e) => e.code).join(', ')})`}; read ${report.readAt}.` };
    },
  })];
}
