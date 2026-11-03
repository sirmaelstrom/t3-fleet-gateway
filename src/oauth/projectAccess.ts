import * as z from 'zod';
import type { GatewayConfig } from '../config.ts';
import { transaction, type Database } from '../db/database.ts';
import { GatewayError } from '../errors.ts';

const grantSchema = z.strictObject({ host: z.string().min(1).max(32), alias: z.string().min(1).max(256).optional(),
  projectId: z.string().min(1).max(256).regex(/^[^\s\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+$/u).optional() }).refine((g) => g.alias !== undefined || g.projectId !== undefined);
const grantsSchema = z.array(grantSchema).max(100);
export type ProjectGrant = z.infer<typeof grantSchema>;
/** undefined means unrestricted; [] denies every project. Invalid stored policy fails closed. */
export type ProjectAccess = readonly ProjectGrant[] | undefined;
export function projectAccess(db: Database, clientId: string): ProjectAccess {
  const row = db.prepare('SELECT projects FROM client_project_access WHERE client_id = ?').get(clientId);
  if (!row) return undefined;
  try {
    const parsed = grantsSchema.safeParse(JSON.parse(String(row.projects)));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}

/** An id grant also covers configured aliases pinned to that exact host/id, including their queued jobs. */
export function expandProjectAccess(access: ProjectAccess, config: Pick<GatewayConfig, 'projects'>): ProjectAccess {
  return access?.flatMap((g) => [g, ...config.projects.filter((p) => p.host === g.host && p.t3ProjectId !== undefined &&
    p.t3ProjectId === g.projectId && p.alias !== g.alias).map((p) => ({ host: p.host, alias: p.alias, projectId: p.t3ProjectId! }))]);
}

export function allowsProject(access: ProjectAccess, host: string, alias?: string | null, projectId?: string | null): boolean {
  return access === undefined || access.some((g) => g.host === host &&
    ((g.alias !== undefined && g.alias === alias) || (g.projectId !== undefined && g.projectId === projectId)));
}
export function projectDenied(): never {
  throw new GatewayError('insufficient_scope', 'This client is not approved for that project. Ask the operator to update clients projects.');
}

/** Shared SQL filter, applied before pagination, row parsing, counts and attention. Table names are internal constants. */
export function projectFilter(access: ProjectAccess, table = 'jobs'): { sql: string; params: string[] } {
  if (access === undefined) return { sql: '1', params: [] };
  const params: string[] = [];
  const clauses = access.map((g) => {
    params.push(g.host);
    const matches = [];
    if (g.alias !== undefined) { matches.push(`${table}.project_alias = ?`); params.push(g.alias); }
    if (g.projectId !== undefined) { matches.push(`${table}.t3_project_id = ?`); params.push(g.projectId); }
    return `(${table}.host_id = ? AND (${matches.join(' OR ')}))`;
  });
  return { sql: clauses.join(' OR ') || '0', params };
}

/** Local operator changes apply on the next request; no token reissue or process restart. */
export function setProjectAccess(db: Database, clientId: string, access: ProjectAccess): void {
  if (access !== undefined && !grantsSchema.safeParse(access).success) throw new GatewayError('invalid_argument', 'Invalid project allowlist.');
  transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM oauth_clients WHERE id = ?').get(clientId)) throw new GatewayError('not_found', 'No client with that id.');
    if (access === undefined) db.prepare('DELETE FROM client_project_access WHERE client_id = ?').run(clientId);
    else db.prepare(`INSERT INTO client_project_access (client_id, projects) VALUES (?, ?)
      ON CONFLICT(client_id) DO UPDATE SET projects = excluded.projects`).run(clientId, JSON.stringify(access));

  });
}

/** Pin configured ids where available; title-only aliases remain opt-in by alias, without any T3 read. */
export function projectGrant(config: GatewayConfig, ref: string): ProjectGrant {
  const alias = config.projects.find((p) => p.alias === ref);
  if (alias) return { host: alias.host, alias: alias.alias, ...(alias.t3ProjectId === undefined ? {} : { projectId: alias.t3ProjectId }) };
  const match = /^@([^/]+)\/(.+)$/.exec(ref);
  if (!match || !config.hosts.some((h) => h.id === match[1]) || match[2]!.length > 256) {
    throw new GatewayError('invalid_argument', 'Use a configured alias or @host/projectId from fleet_projects.');
  }
  return { host: match[1]!, projectId: match[2]! };
}
