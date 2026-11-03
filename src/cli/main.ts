import { projectAccess, projectGrant, setProjectAccess } from '../oauth/projectAccess.ts';
import { parseArgs } from 'node:util';
import { loadConfig, mcpResource, resolvePaths, type GatewayConfig, type Paths } from '../config.ts';
import { describeError, GatewayError, isGatewayError } from '../errors.ts';
import { openServices, openStorage, startGateway, type GatewayServices } from '../gateway.ts';
import { MAX_TITLE_CHARS } from '../jobs/service.ts';
import { TERMINAL_STATES } from '../jobs/states.ts';
import type { Job } from '../jobs/store.ts';
import { createLogger, isLogLevel, silentLogger, type Logger } from '../log.ts';
import { ApprovalCodes, DEFAULT_APPROVAL_CODE_TTL, MAX_APPROVAL_CODE_TTL, MAX_FAILURES_PER_HOUR } from '../oauth/approvalCodes.ts';
import { ClientStore, isTokenClient, MAX_CLIENT_NAME_LENGTH, MAX_REGISTRATIONS_PER_HOUR } from '../oauth/clients.ts';
import { diagnoseClient } from '../oauth/diagnostics.ts';
import { describeAccess, parseHostScope, parseScope, scopesForGrant, type HostChoice } from '../oauth/scopes.ts';
import { changeThreadScopes, clientThreadScopes } from '../oauth/threadScopes.ts';
import { NEVER_EXPIRES } from '../oauth/tokens.ts';
import { FATAL_SHUTDOWN_MS, guardProcess } from '../processErrors.ts';
import { DAY, HOUR, MINUTE, parseDuration, systemClock } from '../time.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import { pingStoredWebhook, pingWebhook } from '../webhooks/sender.ts';
import { WebhookStore } from '../webhooks/store.ts';
import { runDoctor } from './doctor.ts';
import { escapeControls, relative, shortTime, table } from './format.ts';

export interface CliIo {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Resolves when the process is asked to stop (serve only). Receives the port the gateway listens on. */
  waitForShutdown?: (gateway: { port: number }) => Promise<void>;
  /** Listen on this port instead of the configured one; 0 lets the OS pick (tests). */
  listenPort?: number;
}

const USAGE = `Usage: ${GATEWAY_NAME} <command> [options]

Commands:
  serve                     Run the gateway (HTTP server, job engine, credential renewal,
                            webhooks and optional private operator dashboard)
  pair [--ttl 15m]          Mint a one-time approval code for connecting an agent
  clients list              List registered agent clients
  clients token --name <name> [--access operate|read] [--hosts all|<id>,<id>] [--ttl 1y|never]
                            Mint a bearer token for an agent that cannot sign in with OAuth;
                            --hosts limits it to those host ids (default all: every host,
                            including hosts added later)
  clients projects <id> [--project <alias|@host/projectId> ... | --all-projects | --no-projects]
                            Show or replace project access (omitted policy: all projects)
  clients tokens <id>        List bearer token IDs, expiry, last use and recent tool call counts
  clients rotate <id> --token-id <id> --overlap 7d [--ttl 1y|never]
                            Print a replacement token once, preserving client and scopes
  clients revoke-token <id> --token-id <id>
                            Immediately revoke just that bearer token
  clients diagnose <id>      Diagnose stored grants and authentication recovery (offline)
  clients grant <id> --scope threads:read [--scope threads:control]
                            Add external-thread scopes in place (same token, no restart)
  clients scopes <id>        Show client scopes without token material
  clients ungrant <id> --scope <scope> [--scope <scope> ...]
                            Remove named thread scopes, keeping the client and its token
  clients revoke <id>       Revoke a client and every token issued to it
  hosts enroll <id>         Obtain a T3 credential for a host via pairing-code approval
  hosts status              Show each host's credential and reachability
  throttle status           Show failed approvals and registrations counting toward their limits
  throttle reset            Clear the approval and registration throttles
  jobs adopt <project> <threadId> [--title <text>]
                            Register an existing T3 thread as a standing job agents can drive
  jobs list [--all]         List open jobs (--all: finished ones too)
  jobs release <jobId>      Stop following a standing job; the T3 thread is left as it is
  webhooks list             Show subscriptions, ownership and safe delivery counts (offline)
  webhooks attempts <id> [--limit 20]
                            Show recent delivery attempts, codes only (offline)
  webhooks replay <id> (--after <cursor> | --since <ISO time>) [--limit 200]
                            Requeue retained original events (offline; receiver deduplicates eventId)
  webhooks ping <id>         Test a file-managed or dashboard connection with synthetic content
  doctor                    Check config, permissions, database, hosts, public URL and dashboard

Options:
  --config <path>           Config file (default: $T3FG_CONFIG or ~/.config/t3-fleet-gateway/config.json)
  --data-dir <path>         Data directory (default: $T3FG_DATA_DIR or ~/.local/share/t3-fleet-gateway)
  -h, --help                Show this help
  -v, --version             Show the version`;

class UsageError extends Error {}

function logLevelLogger(env: NodeJS.ProcessEnv, sink: (line: string) => void, fallback: 'info' | 'off'): Logger {
  const level = env.T3FG_LOG_LEVEL;
  if (level && isLogLevel(level)) return createLogger({ level, sink });
  return fallback === 'info' ? createLogger({ level: 'info', sink }) : silentLogger;
}

function withServices<T>(paths: Paths, logger: Logger, env: NodeJS.ProcessEnv, fn: (services: GatewayServices, config: GatewayConfig) => Promise<T>): Promise<T> {
  const config = loadConfig(paths.configPath);
  const services = openServices({ config, dataDir: paths.dataDir, logger, commandEnv: env });
  return fn(services, config).finally(() => services.close());
}

async function serve(paths: Paths, io: CliIo): Promise<number> {
  const logger = logLevelLogger(io.env, (line) => io.out(line), 'info');
  const config = loadConfig(paths.configPath);
  const guard = guardProcess(logger);
  try {
    const gateway = await startGateway({ config, dataDir: paths.dataDir, logger, commandEnv: io.env, ...(io.listenPort === undefined ? {} : { port: io.listenPort }) });
    const fatal = await Promise.race([(io.waitForShutdown ?? waitForSignal)(gateway).then(() => false), guard.fatal.then(() => true)]);
    if (!fatal) {
      await gateway.close();
      return 0;
    }
    // The process may be in a broken state: try to stop cleanly, but not for long. Job state is in the database.
    const timer = Promise.withResolvers<boolean>();
    const timeout = setTimeout(() => timer.resolve(false), FATAL_SHUTDOWN_MS);
    const closed = await Promise.race([gateway.close().then(() => true), timer.promise]);
    clearTimeout(timeout);
    if (!closed) logger.error('gateway.shutdown_timeout');
    return 1;
  } finally {
    guard.remove();
  }
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

function pair(paths: Paths, io: CliIo, ttlText: string | undefined): number {
  const ttl = ttlText === undefined ? DEFAULT_APPROVAL_CODE_TTL : parseDuration(ttlText);
  if (ttl === undefined || ttl < MINUTE || ttl > MAX_APPROVAL_CODE_TTL) throw new UsageError('--ttl must be a duration from 1m to 24h, for example 15m');
  const storage = openStorage(paths.dataDir);
  try {
    const { code, expiresAt, clearedLock } = new ApprovalCodes(storage.db, storage.key, systemClock).mint(ttl);
    if (clearedLock) {
      io.out(`Approvals were paused after ${MAX_FAILURES_PER_HOUR} failed attempts within an hour; minting this code lifted the pause.`);
    }
    io.out(`Approval code: ${code}`);
    io.out(`Expires ${shortTime(expiresAt)} (${relative(expiresAt - Date.now())}). It works once.`);
    io.out('Enter it on the approval page your agent opens, then choose Read or Operate, and All machines or Selected machines.');
    return 0;
  } finally {
    storage.db.close();
  }
}

/** How long a `clients token` token lasts unless --ttl says otherwise, and the longest finite --ttl (`never` is longer). */
const DEFAULT_TOKEN_TTL = 365 * DAY;
const MAX_TOKEN_TTL = 100 * 365 * DAY;

interface TokenOptions {
  name?: string | undefined;
  access?: string | undefined;
  hosts?: string | undefined;
  ttl?: string | undefined;
}

const HOSTS_USAGE = '--hosts must be all, or a comma-separated list of host ids from the config, for example mini,macbook';

/** `--hosts`: omitted or `all` is every host (the fleet scopes); otherwise an explicit, non-empty list of host ids. */
function parseHostsOption(value: string | undefined): HostChoice {
  if (value === undefined || value === 'all') return 'all';
  const ids = value.split(',');
  if (ids.some((id) => id.length === 0 || parseHostScope(`host:${id}:read`) === undefined)) throw new UsageError(HOSTS_USAGE);
  if (ids.includes('all')) throw new UsageError('--hosts all cannot be combined with host ids');
  return [...new Set(ids)];
}

function describeHosts(hosts: HostChoice): string {
  return hosts === 'all' ? 'all hosts, including hosts added later' : `host${hosts.length === 1 ? '' : 's'} ${hosts.join(', ')} only`;
}

/** `clients token`: a bearer token for one agent, shown once. The gateway keeps only its hash. */
async function clientToken(paths: Paths, io: CliIo, options: TokenOptions): Promise<number> {
  const name = options.name?.replaceAll(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > MAX_CLIENT_NAME_LENGTH) throw new UsageError(`clients token needs --name, 1 to ${MAX_CLIENT_NAME_LENGTH} characters`);
  const access = options.access ?? 'operate';
  if (access !== 'operate' && access !== 'read') throw new UsageError('--access must be operate (start and steer work, the default) or read');
  const hosts = parseHostsOption(options.hosts);
  const ttl = options.ttl === undefined ? DEFAULT_TOKEN_TTL : options.ttl === 'never' ? null : parseDuration(options.ttl);
  if (ttl === undefined || (ttl !== null && (ttl < HOUR || ttl > MAX_TOKEN_TTL))) {
    throw new UsageError('--ttl must be a duration from 1h to 100y, for example 90d or 1y, or never');
  }
  return withServices(paths, silentLogger, io.env, async ({ tokens, clock }, config) => {
    const unknown = hosts === 'all' ? [] : hosts.filter((id) => !config.hosts.some((host) => host.id === id));
    if (unknown.length > 0) {
      throw new GatewayError(
        'host_not_found',
        `No host ${unknown.join(', ')} in the config. Configured hosts: ${config.hosts.map((host) => host.id).join(', ')}. No token was created.`,
      );
    }
    const expiresAt = ttl === null ? NEVER_EXPIRES : clock() + ttl;
    const { clientId, token, tokenId } = tokens.issueOperatorToken({ name, scopes: scopesForGrant(access, hosts), expiresAt });
    const expiry = ttl === null ? 'never expires' : `expires ${shortTime(expiresAt)} (${relative(ttl)})`;
    io.out(`Created client ${clientId} ("${name}", ${access} access to ${describeHosts(hosts)}). Its token ${expiry}:`);
    io.out(token);
    io.out("This is the only time the token is shown. Put it in the agent's bearer token setting (Authorization: Bearer <token>).");
    io.out(`Token ID: ${tokenId}`);
    io.out(`Revoke it with: clients revoke ${clientId}`);
    return 0;
  });
}

async function manageTokens(paths: Paths, io: CliIo, action: string, clientId: string | undefined,
  tokenId: string | undefined, overlap: string | undefined, ttlText: string | undefined): Promise<number> {
  if (!clientId) throw new UsageError(`clients ${action} needs a client id`);
  if (action !== 'tokens' && !tokenId) throw new UsageError('--token-id is required (see clients tokens <client id>)');
  const overlapMs = overlap === '0' ? 0 : parseDuration(overlap ?? '');
  if (action === 'rotate' && (overlapMs === undefined || overlapMs < 0 || overlapMs > 30 * DAY)) {
    throw new UsageError('--overlap is required: 0 or a duration up to 30d');
  }
  const ttl = ttlText === 'never' ? null : ttlText === undefined ? DEFAULT_TOKEN_TTL : parseDuration(ttlText);
  if (action === 'rotate' && (ttl === undefined || (ttl !== null && (ttl < HOUR || ttl > MAX_TOKEN_TTL)))) {
    throw new UsageError('--ttl must be a duration from 1h to 100y, or never');
  }
  return withServices(paths, silentLogger, io.env, async ({ tokens, clients, clock }) => {
    if (!clients.get(clientId)) throw new GatewayError('not_found', 'No client with that id.');
    if (action === 'tokens') io.out(JSON.stringify(tokens.operatorTokens(clientId), null, 2));
    if (action === 'revoke-token') {
      tokens.revokeOperatorToken(clientId, tokenId!);
      io.out('Revoked bearer token. It no longer works.');
    }
    if (action === 'rotate') {
      const result = tokens.rotateOperatorToken(clientId, tokenId!, overlapMs!, ttl === null ? NEVER_EXPIRES : clock() + ttl!);
      io.out(`Replacement token ID: ${result.tokenId}. This is the only time its secret is shown:`);
      io.out(result.token);
    }
    return 0;
  });
}

function clientProjects(paths: Paths, io: CliIo, clientId: string | undefined,
  refs: string[] | undefined, all: boolean | undefined, none: boolean | undefined): number {
  if (!clientId) throw new UsageError('clients projects needs a client id');
  if (Number(refs !== undefined) + Number(all === true) + Number(none === true) > 1) {
    throw new UsageError('Choose --project, --all-projects or --no-projects.');
  }
  if (refs && refs.length > 100) throw new UsageError('At most 100 projects per client.');
  const storage = openStorage(paths.dataDir);
  try {
    if (!new ClientStore(storage.db, systemClock).get(clientId)) throw new GatewayError('not_found', 'No client with that id.');
    if (refs || all || none) {
      const config = loadConfig(paths.configPath);
      setProjectAccess(storage.db, clientId, all ? undefined : refs?.map((ref) => projectGrant(config, ref)) ?? []);
    }
    io.out(JSON.stringify({ projects: projectAccess(storage.db, clientId) ?? null }));
    return 0;
  } finally { storage.db.close(); }
}

function clients(paths: Paths, io: CliIo, action: string | undefined, id: string | undefined, scopes: string[] = []): number {
  const storage = openStorage(paths.dataDir);
  try {
    const store = new ClientStore(storage.db, systemClock);
    if (action === 'grant' || action === 'ungrant') {
      if (!id) throw new UsageError('A client id is required (see clients list).');
      const result = changeThreadScopes(storage.db, systemClock, id, action === 'grant' ? 'grant' : 'revoke', scopes);
      io.out(`Client ${id}: thread scopes ${result.scopes.join(' ') || '(none)'} (${result.changed ? 'changed' : 'unchanged'}). Existing tokens take effect on their next request; no restart needed.`);
      return 0;
    }
    if (action === 'scopes') {
      if (!id) throw new UsageError('clients scopes needs a client id (see clients list).');
      const client = store.list().find((candidate) => candidate.id === id);
      if (!client) throw new GatewayError('not_found', 'No client with that id.');
      io.out(`Client: ${client.id}\nName: ${escapeControls(client.name)}\nScopes: ${client.scopes.join(' ') || '(none)'}\nThread scopes: ${clientThreadScopes(storage.db, id).join(' ') || '(none)'}`);
      return 0;
    }
    if (action === 'list') {
      const list = store.list();
      if (list.length === 0) {
        io.out('No clients registered.');
        return 0;
      }
      const now = Date.now();
      const rows = list.map((client) => {
        const access = describeAccess(client.scopes);
        const expired = client.tokenExpiresAt !== null && client.tokenExpiresAt <= now;
        const status = client.revokedAt !== null ? 'revoked' : client.totalFamilies === 0 ? 'pending'
          : client.activeFamilies === 0 ? 'grants revoked' : isTokenClient(client) && client.tokenExpiresAt === null ? 'tokens revoked'
            : expired ? 'expired' : isTokenClient(client) ? 'active' : 'unrevoked';
        const signIn = !isTokenClient(client)
          ? `${[...new Set(client.redirectUris.map((uri) => new URL(uri).origin))].join(' ')} (${client.activeFamilies} unrevoked grants; diagnose for usability)`
          : client.tokenExpiresAt === null ? 'bearer token, none unrevoked'
          : client.tokenExpiresAt === NEVER_EXPIRES
            ? 'bearer token, never expires'
            : `bearer token, expires ${shortTime(client.tokenExpiresAt)}`;
        return [client.id, client.name, access, status, shortTime(client.createdAt), shortTime(client.lastUsedAt), client.scopes.join(' ') || '-', signIn];
      });
      io.out(table(['ID', 'NAME', 'ACCESS', 'STATUS', 'CREATED', 'LAST USED', 'SCOPES', 'SIGN-IN'], rows));
      return 0;
    }
    if (action === 'diagnose') {
      if (!id) throw new UsageError('clients diagnose needs a client id (see clients list)');
      const config = loadConfig(paths.configPath);
      const diagnostic = diagnoseClient(storage.db, systemClock, mcpResource(config), id);
      if (!diagnostic) throw new GatewayError('not_found', `No client with id ${id}`);
      const time = (value: number | null): string => value === null ? 'unknown (not observed; old data or never succeeded)'
        : value === NEVER_EXPIRES ? 'never' : new Date(value).toISOString();
      io.out(`Client: ${id}\nKind: ${diagnostic.kind}\nState: ${diagnostic.state}\nChecked: ${time(diagnostic.checkedAt)}`);
      io.out(`Reachability: unknown (offline store read). Run: t3-fleet-gateway doctor`);
      io.out('Doctor checks the operator route at check time, not the cloud connector route; it also checks downstream hosts separately.');
      io.out(`Usable access grant: ${diagnostic.usableAccess}\nUsable refresh grant: ${diagnostic.usableRefresh}`);
      io.out(`Client revoked at: ${diagnostic.revokedAt === null ? 'no' : time(diagnostic.revokedAt)}`);
      io.out(`Last successful MCP: ${time(diagnostic.lastMcpSuccessAt)} (sampled at most once per minute)`);
      io.out(`Last successful refresh: ${time(diagnostic.lastRefreshSuccessAt)} (pair issuance, including grace retry)`);
      for (const family of diagnostic.families) {
        const revokedAt = family.revokedAt === null ? 'no' : time(family.revokedAt);
        const reason = family.revocationReason ?? (family.revokedAt === null ? 'none' : 'unknown');
        io.out(`Grant ${family.id}: revoked at ${revokedAt}; reason ${reason}`);
        const scopes = parseScope(family.scope);
        io.out(`  granted access: ${scopes ? describeAccess(scopes) : 'none (unrecognized scope; grants nothing)'}`);
        const gone = [...new Set((scopes ?? []).map(parseHostScope).filter((host) => host !== undefined).map((host) => host.hostId))]
          .filter((hostId) => !config.hosts.some((host) => host.id === hostId));
        if (gone.length > 0) io.out(`  not configured: ${gone.join(', ')} (no access there unless a host with that id is configured again)`);
        for (const kind of ['access', 'refresh'] as const) {
          if (family[kind].length === 0) io.out(`  ${kind}: none`);
          for (const grant of family[kind]) {
            io.out(`  ${kind}: ${grant.state}, count ${grant.count}, expires ${time(grant.earliestExpiresAt)} to ${time(grant.latestExpiresAt)}`);
          }
        }
      }
      io.out('These grants describe server capability; the gateway cannot know which token or sibling the connector saved.');
      io.out(diagnostic.kind === 'bearer'
        ? 'Static bearer clients have no refresh. Replace an expired or revoked bearer through clients token and the connector settings.'
        : 'Preserve saved credentials and the feed cursor during connectivity failures. Retry after ingress returns; reauthorize only if saved refresh is rejected or expired.');
      io.out('Inspect the connector routine and re-enable it if disabled. Longer token lifetimes do not restart a disabled routine.');
      return 0;
    }
    if (action === 'revoke') {
      if (!id) throw new UsageError('clients revoke needs a client id (see clients list)');
      const result = store.revoke(id);
      if (!result) throw new GatewayError('not_found', `No client with id ${id}`);
      io.out(`Revoked client ${id} and ${result.families} unrevoked grant(s). Its tokens no longer work.`);
      return 0;
    }
    throw new UsageError('Use: clients list | clients scopes <id> | clients grant <id> --scope <scope> | clients ungrant <id> --scope <scope> | clients revoke <id> | clients diagnose <id> | clients token --name <name>');
  } finally {
    storage.db.close();
  }
}

function throttle(paths: Paths, io: CliIo, action: string | undefined): number {
  const storage = openStorage(paths.dataDir);
  try {
    const approvals = new ApprovalCodes(storage.db, storage.key, systemClock);
    const store = new ClientStore(storage.db, systemClock);
    if (action === 'status') {
      const failures = approvals.globalFailures();
      const registrations = store.registrationsCounted();
      const state = (count: number, limit: number) => (count >= limit ? 'LIMIT REACHED' : 'ok');
      io.out(`approvals:     ${failures}/${MAX_FAILURES_PER_HOUR} failed attempts in the last hour (${state(failures, MAX_FAILURES_PER_HOUR)})`);
      io.out(`registrations: ${registrations}/${MAX_REGISTRATIONS_PER_HOUR} counted in the last hour (${state(registrations, MAX_REGISTRATIONS_PER_HOUR)})`);
      return 0;
    }
    if (action === 'reset') {
      approvals.resetThrottles();
      store.resetRegistrationLimit();
      io.out('Cleared the failed approval attempts (locked approval pages included) and the registration limit.');
      return 0;
    }
    throw new UsageError('Use: throttle status | throttle reset');
  } finally {
    storage.db.close();
  }
}

async function hosts(paths: Paths, io: CliIo, action: string | undefined, id: string | undefined): Promise<number> {
  const logger = logLevelLogger(io.env, (line) => io.err(line), 'off');
  if (action === 'enroll') {
    if (!id) throw new UsageError('hosts enroll needs a host id from the config');
    return withServices(paths, logger, io.env, async ({ registry }) => {
      const host = registry.host(id);
      io.out(`Enrolling host ${id} at ${host.t3Url} with T3 access "${host.access}"; running the configured mint command`);
      const result = await registry.enroll(id);
      io.out(`Enrolled ${id}: T3 ${result.t3Version}, credential expires ${shortTime(result.expiresAt)} (${relative(result.expiresAt - Date.now())}).`);
      return 0;
    });
  }
  if (action === 'status') {
    return withServices(paths, logger, io.env, async ({ registry }, config) => {
      for (const host of config.hosts) {
        const credential = registry.credentialStatus(host.id);
        const health = await registry.health(host.id, { fresh: true });
        io.out(`${host.id}${host.label ? ` (${host.label})` : ''}  ${host.t3Url}`);
        const reach = health.credentialRejected
          ? 'yes'
          : health.reachable
            ? `yes, T3 ${health.t3Version}`
            : `no (${health.error?.code}: ${health.error?.message})`;
        io.out(`  reachable:  ${reach}`);
        const expiry = credential.expiresAt === null ? '' : `, expires ${shortTime(credential.expiresAt)} (${relative(credential.expiresAt - Date.now())})`;
        io.out(`  credential: ${health.credentialRejected ? 'rejected by T3' : credential.state}${expiry}`);
        if (health.credentialRejected) io.out(`  error:      ${health.error?.code}: ${health.error?.message}`);
        if (credential.renewalError) {
          io.out(`  renewal:    failed ${shortTime(credential.renewalError.at)}: ${credential.renewalError.code}: ${credential.renewalError.message}`);
        }
      }
      return 0;
    });
  }
  throw new UsageError('Use: hosts enroll <id> | hosts status');
}

function describeJobLine(job: Job): string {
  return `${job.id}  ${job.projectAlias}  ${job.state}${job.standing ? '  standing' : ''}  ${escapeControls(job.title)}${job.threadLink ? `  ${escapeControls(job.threadLink)}` : ''}`;
}

const MAX_LISTED_JOBS = 1000;

interface JobsOptions {
  title?: string | undefined;
  all?: boolean | undefined;
}

async function jobs(paths: Paths, io: CliIo, action: string | undefined, args: string[], options: JobsOptions): Promise<number> {
  const logger = logLevelLogger(io.env, (line) => io.err(line), 'off');
  if (action === 'adopt') {
    const [project, threadId, ...extra] = args;
    if (!project || !threadId) throw new UsageError('jobs adopt needs a project alias and a T3 thread id');
    if (extra.length > 0) throw new UsageError(`Unexpected arguments: ${extra.join(' ')}`);
    const title = options.title?.trim();
    if (options.title !== undefined && (!title || title.length > MAX_TITLE_CHARS)) throw new UsageError(`--title must be 1 to ${MAX_TITLE_CHARS} characters`);
    return withServices(paths, logger, io.env, async (services) => {
      const { job, created } = await services.jobs.adopt({ project, threadId, title });
      io.out(created ? `Adopted thread ${job.threadId} as standing job ${job.id}.` : `Thread ${job.threadId} is already standing job ${job.id}.`);
      io.out(describeJobLine(job));
      io.out(`Agents send it work with work_continue and follow it with work_feed and work_status. Stop following it with: jobs release ${job.id}`);
      return 0;
    });
  }
  if (action === 'list') {
    if (args.length > 0) throw new UsageError(`Unexpected arguments: ${args.join(' ')}`);
    return withServices(paths, logger, io.env, async (services) => {
      const all = services.jobs.store.list({ limit: MAX_LISTED_JOBS });
      const shown = options.all ? all : all.filter((job) => !TERMINAL_STATES.includes(job.state));
      if (shown.length === 0) {
        io.out(options.all ? 'No jobs.' : 'No open jobs. (--all shows finished ones too.)');
        return 0;
      }
      const rows = shown.map((job) => [job.id, job.projectAlias, job.state, job.standing ? 'yes' : '-', job.title, job.threadLink ?? '-']);
      io.out(table(['ID', 'PROJECT', 'STATE', 'STANDING', 'TITLE', 'LINK'], rows));
      return 0;
    });
  }
  if (action === 'release') {
    const [jobId, ...extra] = args;
    if (!jobId) throw new UsageError('jobs release needs a job id (see jobs list)');
    if (extra.length > 0) throw new UsageError(`Unexpected arguments: ${extra.join(' ')}`);
    return withServices(paths, logger, io.env, async (services) => {
      const { job, released } = services.jobs.release(jobId);
      io.out(
        released
          ? `Released standing job ${job.id}; agents can no longer send it work. The T3 thread was not touched.`
          : `Job ${job.id} is already ${job.state}.`,
      );
      return 0;
    });
  }
  throw new UsageError('Use: jobs adopt <project> <threadId> [--title <text>] | jobs list [--all] | jobs release <jobId>');
}

async function webhooks(paths: Paths, io: CliIo, action: string | undefined, id: string | undefined, limitText?: string, afterCursor?: string, since?: string): Promise<number> {
  if (!['list', 'attempts', 'ping', 'replay'].includes(action ?? '') || (action !== 'list' && !id) || (action === 'list' && id)) {
    throw new UsageError('Use: webhooks list | webhooks attempts <id> [--limit 20] | webhooks ping <id>');
  }
  const limit = limitText === undefined ? (action === 'replay' ? 200 : 20) : Number(limitText);
  const max = action === 'replay' ? 200 : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new UsageError(`--limit must be 1 to ${max}`);
  const storage = openStorage(paths.dataDir);
  try {
    const store = new WebhookStore(storage.db, systemClock);
    if (action === 'replay') {
      io.out(JSON.stringify(store.replay(id!, { afterCursor, since, limit }), null, 2));
      return 0;
    }
    if (action === 'attempts') {
      io.out(JSON.stringify(store.diagnostics(id, limit), null, 2));
      return 0;
    }
    const config = loadConfig(paths.configPath);
    if (action === 'list') {
      io.out(JSON.stringify({ configured: config.webhooks.subscriptions.map(({ id, enabled }) => ({ id, enabled })), ...store.diagnostics() }, null, 2));
      return 0;
    }
    const subscription = config.webhooks.subscriptions.find((s) => s.id === id);
    const saved = store.listConnections().find((s) => s.id === id && s.source === 'dashboard');
    if (subscription && saved) throw new GatewayError('config_invalid', 'Webhook subscription ownership conflicts with configuration.');
    if (!subscription && !saved) throw new GatewayError('not_found', 'Webhook subscription was not found.');
    const result = saved ? await pingStoredWebhook(saved.id, saved.revision, store, systemClock)
      : await pingWebhook(subscription!, paths.dataDir, store, systemClock);
    io.out(JSON.stringify(result));
    return result.outcome === 'delivered' ? 0 : 1;
  } finally { storage.db.close(); }
}

async function doctor(paths: Paths, io: CliIo): Promise<number> {
  let config: GatewayConfig;
  try {
    config = loadConfig(paths.configPath);
  } catch (error) {
    io.out(`FAIL  config: ${describeError(error).message}`);
    return 1;
  }
  io.out(`config: ${paths.configPath}`);
  const services = openServices({ config, dataDir: paths.dataDir, logger: logLevelLogger(io.env, (line) => io.err(line), 'off'), commandEnv: io.env });
  try {
    const results = await runDoctor(services, paths.dataDir);
    for (const result of results) io.out(`${result.level.toUpperCase().padEnd(4)}  ${result.name}: ${result.detail}`);
    return results.some((result) => result.level === 'fail') ? 1 : 0;
  } finally {
    await services.close();
  }
}

/** Run the CLI and return the exit code: 0 success, 1 failure, 2 usage error. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'data-dir': { type: 'string' },
        ttl: { type: 'string' },
        project: { type: 'string', multiple: true },
        'all-projects': { type: 'boolean' },
        'no-projects': { type: 'boolean' },
        'token-id': { type: 'string' },
        overlap: { type: 'string' },
        name: { type: 'string' },
        access: { type: 'string' },
        hosts: { type: 'string' },
        title: { type: 'string' },
        all: { type: 'boolean' },
        limit: { type: 'string' },
        after: { type: 'string' },
        since: { type: 'string' },
        scope: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    if (values.version) {
      io.out(GATEWAY_VERSION);
      return 0;
    }
    const [command, action, ...args] = positionals;
    const id = args[0];
    if (values.help || command === undefined) {
      io.out(USAGE);
      return values.help ? 0 : 2;
    }
    // `jobs` checks its own arguments: `jobs adopt` takes two.
    if (command !== 'jobs' && args.length > 1) throw new UsageError(`Unexpected arguments: ${args.slice(1).join(' ')}`);
    if (command === 'clients' && action === 'revoke' && values.scope !== undefined) {
      throw new UsageError('clients revoke revokes the whole client; use clients ungrant <id> --scope <scope> to remove thread scopes.');
    }
    if (command === 'clients' && (action === 'grant' || action === 'ungrant') && !values.scope?.length) {
      throw new UsageError(`clients ${action} requires at least one --scope (threads:read or threads:control).`);
    }
    // Each of these options belongs to one command; anywhere else it would be ignored silently.
    const optionCommands = [
      ['project', values.project, 'clients projects', command === 'clients' && action === 'projects'],
      ['all-projects', values['all-projects'], 'clients projects', command === 'clients' && action === 'projects'],
      ['no-projects', values['no-projects'], 'clients projects', command === 'clients' && action === 'projects'],
      ['token-id', values['token-id'], 'clients rotate/revoke-token', command === 'clients' && (action === 'rotate' || action === 'revoke-token')],
      ['overlap', values.overlap, 'clients rotate', command === 'clients' && action === 'rotate'],
      ['ttl', values.ttl, 'pair and clients token/rotate', command === 'pair' || (command === 'clients' && (action === 'token' || action === 'rotate'))],
      ['name', values.name, 'clients token', command === 'clients' && action === 'token'],
      ['access', values.access, 'clients token', command === 'clients' && action === 'token'],
      ['hosts', values.hosts, 'clients token', command === 'clients' && action === 'token'],
      ['title', values.title, 'jobs adopt', command === 'jobs' && action === 'adopt'],
      ['all', values.all, 'jobs list', command === 'jobs' && action === 'list'],
      ['scope', values.scope, 'clients grant/ungrant', command === 'clients' && (action === 'grant' || action === 'ungrant')],
      ['limit', values.limit, 'webhooks attempts/replay', command === 'webhooks' && (action === 'attempts' || action === 'replay')],
      ['after', values.after, 'webhooks replay', command === 'webhooks' && action === 'replay'],
      ['since', values.since, 'webhooks replay', command === 'webhooks' && action === 'replay'],
    ] as const;
    for (const [option, value, owner, allowed] of optionCommands) {
      if (value !== undefined && !allowed) throw new UsageError(`--${option} is only for ${owner}`);
    }
    const paths = resolvePaths(io.env, {
      ...(values.config ? { configPath: values.config } : {}),
      ...(values['data-dir'] ? { dataDir: values['data-dir'] } : {}),
    });
    switch (command) {
      case 'serve':
        return await serve(paths, io);
      case 'pair':
        return pair(paths, io, values.ttl);
      case 'clients':
        if (action === 'projects') return clientProjects(paths, io, id, values.project, values['all-projects'], values['no-projects']);
        if (['tokens', 'rotate', 'revoke-token'].includes(action ?? '')) {
          return await manageTokens(paths, io, action!, id, values['token-id'], values.overlap, values.ttl);
        }
        if (action !== 'token') return clients(paths, io, action, id, values.scope);
        if (id !== undefined) throw new UsageError(`Unexpected arguments: ${id}`);
        return await clientToken(paths, io, { name: values.name, access: values.access, hosts: values.hosts, ttl: values.ttl });
      case 'hosts':
        return await hosts(paths, io, action, id);
      case 'throttle':
        if (id !== undefined) throw new UsageError(`Unexpected arguments: ${id}`);
        return throttle(paths, io, action);
      case 'jobs':
        return await jobs(paths, io, action, args, { title: values.title, all: values.all });
      case 'webhooks':
        return await webhooks(paths, io, action, id, values.limit, values.after, values.since);
      case 'doctor':
        return await doctor(paths, io);
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`error: ${(error as Error).message}\nRun ${GATEWAY_NAME} --help for usage.`);
      return 2;
    }
    if (isGatewayError(error)) {
      io.err(`error (${error.code}): ${error.message}`);
      return 1;
    }
    io.err(`error: unexpected ${(error as Error).name ?? 'failure'}: ${(error as Error).message ?? ''}`);
    return 1;
  }
}
