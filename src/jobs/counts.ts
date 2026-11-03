import { projectFilter, type ProjectAccess } from '../oauth/projectAccess.ts';
import type { Database } from '../db/database.ts';
import { RUNNING_STATES } from './states.ts';

export interface HostJobCounts {
  running: number;
  queued: number;
}

/** Running and queued job counts per host id; running counts slot holders, so not standing jobs. Hosts without jobs are absent. */
export function jobCountsByHost(db: Database, access?: ProjectAccess): Map<string, HostJobCounts> {
  const filter = projectFilter(access);
  const placeholders = RUNNING_STATES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT host_id,
              SUM(CASE WHEN standing = 0 AND state IN (${placeholders}) THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued
         FROM jobs WHERE (${filter.sql}) GROUP BY host_id`,
    )
    .all(...RUNNING_STATES, ...filter.params) as { host_id: string; running: number; queued: number }[];
  return new Map(rows.map((row) => [row.host_id, { running: row.running, queued: row.queued }]));
}
