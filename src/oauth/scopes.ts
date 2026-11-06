export const READ_SCOPE = 'fleet:read';
export const OPERATE_SCOPE = 'fleet:operate';
export const THREAD_READ_SCOPE = 'threads:read';
export const THREAD_CONTROL_SCOPE = 'threads:control';
/** Operator-only opt-ins; deliberately absent from advertised/default OAuth grants. They never grant host access. */
export const THREAD_SCOPES = [THREAD_READ_SCOPE, THREAD_CONTROL_SCOPE] as const;
export type ThreadScope = (typeof THREAD_SCOPES)[number];
/**
 * The fleet-wide scopes: every configured host, including hosts added later. They are the only scopes
 * advertised in metadata, so clients that request the advertised scopes keep asking for what they always did.
 */
export const SUPPORTED_SCOPES = [READ_SCOPE, OPERATE_SCOPE] as const;
export type FleetScope = (typeof SUPPORTED_SCOPES)[number];

/** What a scope allows: read (fleet_status and the read-only work tools) or operate (the work tools that change jobs). */
export type AccessLevel = 'read' | 'operate';
/** What the operator grants on the approval page. Operate implies read. */
export type AccessChoice = AccessLevel;
/**
 * One host only: `host:<hostId>:read` or `host:<hostId>:operate`. A grant restricted to selected hosts holds
 * these and no fleet scope, so it never covers a host added later, and removing scopes only removes access.
 */
export type HostScope = `host:${string}:${AccessLevel}`;
export type Scope = FleetScope | HostScope | ThreadScope;
/** The hosts a grant covers: `all` (fleet scopes) or the listed host ids (host scopes). */
export type HostChoice = 'all' | readonly string[];

const HOST_SCOPE = /^host:([a-z0-9][a-z0-9-]{0,31}):(read|operate)$/;
const LEVELS: readonly AccessLevel[] = ['read', 'operate'];

export function fleetScope(level: AccessLevel): FleetScope {
  return level === 'operate' ? OPERATE_SCOPE : READ_SCOPE;
}

export function hostScope(hostId: string, level: AccessLevel): HostScope {
  return `host:${hostId}:${level}`;
}

/** The host and level of a host scope; undefined for anything else. */
export function parseHostScope(value: string): { hostId: string; level: AccessLevel } | undefined {
  const match = HOST_SCOPE.exec(value);
  return match ? { hostId: match[1] as string, level: match[2] as AccessLevel } : undefined;
}

function fleetLevel(value: string): AccessLevel | undefined {
  return value === READ_SCOPE ? 'read' : value === OPERATE_SCOPE ? 'operate' : undefined;
}

function isScope(value: string): value is Scope {
  return fleetLevel(value) !== undefined || parseHostScope(value) !== undefined || THREAD_SCOPES.includes(value as ThreadScope);
}

/** Fleet scopes first, then host scopes by host id, read before operate; no duplicates. */
function canonical(scopes: Iterable<Scope>): Scope[] {
  const unique = [...new Set(scopes)];
  const fleet = SUPPORTED_SCOPES.filter((scope) => unique.includes(scope));
  const hosts = unique
    .map(parseHostScope)
    .filter((scope) => scope !== undefined)
    .sort((a, b) => (a.hostId === b.hostId ? LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) : a.hostId < b.hostId ? -1 : 1))
    .map((scope) => hostScope(scope.hostId, scope.level));
  return [...fleet, ...hosts, ...THREAD_SCOPES.filter((scope) => unique.includes(scope))];
}

export function scopesForChoice(choice: AccessChoice): Scope[] {
  return choice === 'operate' ? [READ_SCOPE, OPERATE_SCOPE] : [READ_SCOPE];
}

/**
 * The scopes for an access level on all hosts (the fleet scopes, as before host selection existed) or on
 * selected hosts only. An empty selection is an error, never all hosts.
 */
export function scopesForGrant(choice: AccessChoice, hosts: HostChoice): Scope[] {
  if (hosts === 'all') return scopesForChoice(choice);
  if (hosts.length === 0) throw new Error('A host selection needs at least one host');
  const levels: AccessLevel[] = choice === 'operate' ? ['read', 'operate'] : ['read'];
  return canonical(hosts.flatMap((hostId) => levels.map((level) => hostScope(hostId, level))));
}

/** Parse a space-delimited scope parameter. Returns undefined when it names an unknown or malformed scope. */
export function parseScope(value: string | null | undefined): Scope[] | undefined {
  const parts = (value ?? '').split(' ').filter((part) => part.length > 0);
  if (!parts.every(isScope)) return undefined;
  return canonical(parts);
}

export function formatScope(scopes: readonly string[]): string {
  return scopes.join(' ');
}

export function isHostScope(scope: string): scope is HostScope {
  return parseHostScope(scope) !== undefined;
}

/** Whether the scopes allow `level` on `hostId`: a fleet scope covers every host, a host scope only its own. */
export function permits(scopes: readonly string[], level: AccessLevel, hostId: string): boolean {
  return scopes.includes(fleetScope(level)) || scopes.includes(hostScope(hostId, level));
}

/** Whether the scopes allow `level` on any host at all. */
export function permitsAny(scopes: readonly string[], level: AccessLevel): boolean {
  return scopes.includes(fleetScope(level)) || scopes.some((scope) => parseHostScope(scope)?.level === level);
}

/** The hosts the scopes allow `level` on: `all` with the fleet scope, otherwise the host ids named (possibly none). */
export function permittedHosts(scopes: readonly string[], level: AccessLevel): 'all' | string[] {
  if (scopes.includes(fleetScope(level))) return 'all';
  return [...new Set(scopes.map(parseHostScope).filter((scope) => scope?.level === level).map((scope) => scope!.hostId))];
}

/**
 * The scopes a caller holds on the configured hosts. A host with `fleetScopes: false` is outside the fleet scopes:
 * while one is configured, each fleet scope stands for the host scopes of the hosts that still accept fleet scopes,
 * so only an explicit `host:<id>:*` grant reaches an opted-out host. Without one the scopes are returned as they are,
 * so a fleet grant keeps covering every host, including hosts added later.
 */
export function scopesOnHosts(scopes: readonly Scope[], hosts: readonly { id: string; fleetScopes: boolean }[]): Scope[] {
  if (hosts.every((host) => host.fleetScopes)) return [...scopes];
  const fleetHosts = hosts.filter((host) => host.fleetScopes).map((host) => host.id);
  return canonical(scopes.flatMap((scope) => {
    const level = fleetLevel(scope);
    return level === undefined ? [scope] : fleetHosts.map((hostId) => hostScope(hostId, level));
  }));
}

/**
 * The scopes a refresh keeps when the client names `scope` (RFC 6749 section 6): never more than the grant.
 * Each requested scope must be one the grant holds, except that a fleet scope requested of a grant restricted
 * to selected hosts stands for that grant's host scopes at the same level (clients that only know the advertised
 * fleet scopes keep their restricted grant, and never gain other hosts). Undefined, an `invalid_scope`, when the
 * request is empty, malformed, or asks for anything the grant does not hold.
 */
export function narrowScopes(granted: readonly Scope[], requested: readonly Scope[] | undefined): Scope[] | undefined {
  if (!requested || requested.length === 0) return undefined;
  const kept = new Set<Scope>();
  for (const scope of requested) {
    if (granted.includes(scope)) {
      kept.add(scope);
      continue;
    }
    const level = fleetLevel(scope);
    const hostScopes = level === undefined ? [] : granted.filter((candidate) => parseHostScope(candidate)?.level === level);
    if (hostScopes.length === 0) return undefined;
    for (const candidate of hostScopes) kept.add(candidate);
  }
  return canonical(kept);
}

/**
 * Whether `granted` stays within what a client asked for. Only requests that name host scopes set a ceiling:
 * then every granted scope must be covered by the request: a host scope by the same host scope or the fleet
 * scope of its level, a fleet scope by itself, and read by operate too (Operate implies read, as on the page).
 * Requests with fleet scopes only, or none, leave the choice to the operator, as before.
 */
export function withinRequest(requested: readonly Scope[], granted: readonly Scope[]): boolean {
  if (!requested.some(isHostScope)) return true;
  const covers = (level: AccessLevel, hostId: string | undefined) => {
    const levels: AccessLevel[] = level === 'read' ? ['read', 'operate'] : ['operate'];
    return levels.some((candidate) => (hostId === undefined ? requested.includes(fleetScope(candidate)) : permits(requested, candidate, hostId)));
  };
  return granted.every((scope) => {
    const host = parseHostScope(scope);
    return host ? covers(host.level, host.hostId) : covers(fleetLevel(scope) ?? 'operate', undefined);
  });
}

/** Operator-facing summary of what scopes allow, for example `operate (all hosts)` or `operate: macbook, mini; read: studio`. */
export function describeAccess(scopes: readonly string[]): string {
  const parts: string[] = [];
  const fleet = scopes.includes(OPERATE_SCOPE) ? 'operate' : scopes.includes(READ_SCOPE) ? 'read' : undefined;
  if (fleet) parts.push(`${fleet} (all hosts)`);
  const byLevel: Record<AccessLevel, string[]> = { operate: [], read: [] };
  const hostIds = [...new Set(scopes.map(parseHostScope).filter((scope) => scope !== undefined).map((scope) => scope.hostId))].sort();
  for (const hostId of hostIds) {
    const level: AccessLevel = scopes.includes(hostScope(hostId, 'operate')) ? 'operate' : 'read';
    // A fleet scope at this level or above already covers the host.
    if (fleet === 'operate' || fleet === level) continue;
    byLevel[level].push(hostId);
  }
  for (const level of ['operate', 'read'] as const) if (byLevel[level].length > 0) parts.push(`${level}: ${byLevel[level].join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : '-';
}
