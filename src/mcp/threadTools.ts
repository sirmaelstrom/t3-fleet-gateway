import * as z from 'zod';
import { responseThreadIdSchema } from '../t3/threadId.ts';
import type { GatewayServices } from '../gateway.ts';
import type { CatalogThread } from '../hosts/threads.ts';
import type { Snapshot } from '../hosts/catalog.ts';
import { GatewayError } from '../errors.ts';
import { permits, READ_SCOPE, THREAD_READ_SCOPE } from '../oauth/scopes.ts';
import { isoTime } from '../time.ts';
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
  })];
}
