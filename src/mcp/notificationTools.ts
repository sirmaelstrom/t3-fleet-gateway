import * as z from 'zod';
import type { GatewayServices } from '../gateway.ts';
import { OPERATE_SCOPE, READ_SCOPE } from '../oauth/scopes.ts';
import { WEBHOOK_EVENTS } from '../webhooks/config.ts';
import { defineTool, type GatewayTool } from './tools.ts';

const connectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
const health = z.object({
  lastSuccessAt: z.string().nullable(), lastFailureAt: z.string().nullable(), failureStreak: z.number(),
  deadLettered: z.number(), pending: z.number(), overflowCount: z.number(), replayFloorCursor: z.string(), oldestReplayAt: z.string().nullable(),
});

/** Bot operations use only operator-provisioned destinations, never caller-supplied URLs or credentials. */
export function notificationTools(services: GatewayServices): GatewayTool[] {
  return [
    defineTool({
      name: 'work_notifications', title: 'Your notification connections', scope: READ_SCOPE, readOnly: true,
      description: 'List notification connections the operator assigned to your client, their event/host/project ceilings, job subscriptions and ' +
        'delivery health. Requires Read on every connection host. No receiver URLs or credentials are returned. Dead-letter and overflow counts ' +
        'are cumulative; use work_replay for retained events and work_feed for older catch-up. No connections means ask the operator to provision one.',
      inputSchema: z.strictObject({}),
      outputSchema: z.object({ connections: z.array(z.object({
        id: z.string(), hosts: z.array(z.string()), projects: z.array(z.string()), jobs: z.array(z.string()),
        targets: z.array(z.object({ host: z.string(), projectId: z.string() })), events, health,
        healthAvailable: z.boolean().describe('false: aggregate connection history is withheld under project restrictions; health counters are placeholders'),
        subscriptions: z.array(z.object({ jobId: z.string(), events })),
      })) }),
      async run(_input, caller) {
        const connections = services.webhooks.ownedConnections(caller).map(({ id, hosts, projects, jobs, targets, events, health, healthAvailable, subscriptions }) =>
          ({ id, hosts, projects, jobs, targets, events, health, healthAvailable, subscriptions }));
        return { structured: { connections }, summary: `${connections.length} notification connection(s) assigned to this client.` };
      },
    }),
    defineTool({
      name: 'work_subscribe', title: 'Subscribe a job to notifications', scope: OPERATE_SCOPE, readOnly: false,
      description: 'Subscribe your own work_start job to an operator-provisioned notification connection. Call after work_start or before ' +
        'work_continue; use work_feed for the interval before subscription. Requires ownership of both connection and job, and Operate on every ' +
        'connection host. Events default to the connection ceiling; repeated identical calls are safe. At most 100 jobs per connection. ' +
        'remove stops future capture only; already captured notices can still arrive. No destinations or credentials are accepted.',
      inputSchema: z.strictObject({ connectionId, jobId: z.string().min(1).max(64), events: events.optional(), remove: z.boolean().default(false) }),
      outputSchema: z.object({ subscribed: z.boolean() }),
      async run(input, caller) {
        services.webhooks.subscribe(caller, input.connectionId, input.jobId, input.events, input.remove);
        return { structured: { subscribed: !input.remove }, summary: input.remove ? 'Job subscription removed.' : 'Job subscription saved.' };
      },
    }),
    defineTool({
      name: 'work_replay', title: 'Replay notification events', scope: OPERATE_SCOPE, readOnly: false,
      description: 'Queue original notification events again for your assigned connection, after a decimal feed cursor (exclusive) or since an ' +
        'ISO timestamp (inclusive). Requires Operate on every connection host. Retains original eventId and event-time payload: receivers must ' +
        'deduplicate. Pending/sending events are skipped; delivered and expired events get a fresh retry window. At most 200 events per page; ' +
        'continue with nextCursor when hasMore. If the queue is full, drain it before continuing. Archive is seven days/10,000 events per connection. ' +
        'retentionGap means use work_feed to catch up older work. No event history before the connection, subscription or upgrade is invented.',
      inputSchema: z.strictObject({ connectionId, afterCursor: z.string().regex(/^\d{1,16}$/).optional(),
        since: z.iso.datetime({ offset: true }).optional(), limit: z.int().min(1).max(200).optional() }),
      outputSchema: z.object({ queued: z.number(), skipped: z.number(), nextCursor: z.string(), hasMore: z.boolean(), retentionGap: z.boolean() }),
      async run({ connectionId, ...input }, caller) {
        const result = services.webhooks.replayOwned(caller, connectionId, input);
        return { structured: result, summary: `${result.queued} notification(s) queued; ${result.skipped} already active.` +
          (result.retentionGap ? ' Older events require work_feed catch-up.' : '') };
      },
    }),
  ];
}
