import { mcpResource, type GatewayConfig } from './config.ts';
import { DashboardChecks } from './dashboard/checks.ts';
import { startDashboard, type RunningDashboard } from './dashboard/server.ts';
import { openDataDir } from './dataDir.ts';
import { openDatabase, type Database } from './db/database.ts';
import { ThreadCatalog } from './hosts/threads.ts';
import { threadTools } from './mcp/threadTools.ts';
import { CatalogService } from './hosts/catalog.ts';
import { CredentialAlerts } from './hosts/alerts.ts';
import { CredentialStore } from './hosts/credentials.ts';
import { warnProjectsWithoutModel } from './hosts/projects.ts';
import { HostRegistry, type HostRegistryOptions } from './hosts/registry.ts';
import { startReachabilityLoop } from './hosts/reachability.ts';
import { startRenewalLoop, type RenewalLoop } from './hosts/renewal.ts';
import { createRouter, listen, type RunningServer } from './http/server.ts';
import { JobEngine } from './jobs/engine.ts';
import { JobService } from './jobs/service.ts';
import { JobStore } from './jobs/store.ts';
import type { Logger } from './log.ts';
import { catalogTools } from './mcp/catalogTools.ts';
import { createMcpEndpoint } from './mcp/endpoint.ts';
import { notificationTools } from './mcp/notificationTools.ts';
import { fleetStatusTool } from './mcp/fleetStatus.ts';
import type { GatewayTool } from './mcp/tools.ts';
import { workTools } from './mcp/workTools.ts';
import { ApprovalCodes } from './oauth/approvalCodes.ts';
import { ClientStore } from './oauth/clients.ts';
import { logTokenEvent, oauthRoutes } from './oauth/routes.ts';
import { TokenService } from './oauth/tokens.ts';
import { MINUTE, systemClock, type Clock } from './time.ts';
import { WebhookSender, type SenderOptions } from './webhooks/sender.ts';
import { WebhookStore } from './webhooks/store.ts';
import { WebhookManagement, type ManagementOptions } from './webhooks/management.ts';

/** Everything that shares the database: used by the server and by CLI commands. */
export interface GatewayServices {
  config: GatewayConfig;
  db: Database;
  key: Buffer;
  clock: Clock;
  logger: Logger;
  clients: ClientStore;
  approvals: ApprovalCodes;
  tokens: TokenService;
  registry: HostRegistry;
  /** Per-host T3 project and model catalogs for agents (opt-in per host). */
  catalog: CatalogService;
  threads: ThreadCatalog;
  jobs: JobService;
  webhooks: WebhookStore;
  close(): Promise<void>;
}

export interface ServiceOptions {
  config: GatewayConfig;
  dataDir: string;
  logger: Logger;
  clock?: Clock;
  runCommand?: HostRegistryOptions['runCommand'];
  commandEnv?: NodeJS.ProcessEnv;
}

export interface Storage {
  db: Database;
  key: Buffer;
}

/** Open the data directory and database only: enough for commands that need no config. */
export function openStorage(dataDir: string): Storage {
  const data = openDataDir(dataDir);
  return { db: openDatabase(data.databasePath), key: data.key };
}

export function openServices(options: ServiceOptions): GatewayServices {
  const { config, logger } = options;
  const clock = options.clock ?? systemClock;
  const { db, key } = openStorage(options.dataDir);
  const webhooks = new WebhookStore(db, clock, config.projects);
  const alerts = new CredentialAlerts(db, clock, config, webhooks);
  const registry = new HostRegistry({
    hosts: config.hosts,
    store: new CredentialStore(db),
    clock,
    logger,
    renewWhenDaysLeft: config.renewal.renewWhenDaysLeft,
    alerts,
    ...(options.runCommand ? { runCommand: options.runCommand } : {}),
    ...(options.commandEnv ? { commandEnv: options.commandEnv } : {}),
  });
  const catalog = new CatalogService(registry, clock, logger);
  return {
    config,
    db,
    key,
    clock,
    logger,
    clients: new ClientStore(db, clock),
    approvals: new ApprovalCodes(db, key, clock),
    tokens: new TokenService(db, clock, { resource: mcpResource(config), ...config.tokens }, logTokenEvent(logger)),
    registry,
    catalog,
    threads: new ThreadCatalog(registry, clock, logger),
    webhooks,
    jobs: new JobService({ config, store: new JobStore(db, clock, logger, webhooks), registry, catalog, clock, logger }),
    async close() {
      await registry.close();
      db.close();
    },
  };
}

export function gatewayTools(services: GatewayServices): GatewayTool[] {
  return [fleetStatusTool(services), ...catalogTools(services), ...threadTools(services), ...workTools(services.jobs), ...notificationTools(services)];
}

export interface RunningGateway {
  services: GatewayServices;
  /** The dispatcher and watcher. */
  engine: JobEngine;
  webhooks: WebhookSender;
  port: number;
  /** The operator dashboard's listener, when `dashboard.enabled`; never the MCP listener. */
  dashboard: { port: number; path: string; checks: DashboardChecks } | null;
  close(): Promise<void>;
}

export interface GatewayOptions extends ServiceOptions {
  tools?: (services: GatewayServices) => GatewayTool[];
  /** Tests drive the actual network sender by hand and can shorten its deadline. */
  webhookSender?: SenderOptions;
  /** Isolated synthetic test/demo transport policy; never populated from operator config. */
  webhookManagement?: ManagementOptions;
  /** Test/demo harnesses may disable the autonomous reachability timer. */
  reachability?: { autoStart?: boolean };
  /** Tests drive the job engine by hand (`autoStart: false`) or with a short interval. */
  jobEngine?: { autoStart?: boolean; intervalMs?: number; launchTimeoutMs?: number };
  /** Listen on this port instead of `config.listen.port`; 0 lets the OS pick one (tests). */
  port?: number;
  /** The same for the dashboard listener (`dashboard.listen.port`). */
  dashboardPort?: number;
  /** A badge the dashboard shows on every page; the synthetic demo sets it. */
  dashboardDemoLabel?: string;
}

/** Start the HTTP server (OAuth + MCP), the job engine and the credential renewal loop. */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const services = openServices(options);
  const webhooks = new WebhookSender(services.webhooks, services.logger, options.webhookSender);
  const startedAt = services.clock();
  const { config, logger } = services;
  const management = new WebhookManagement(services.webhooks, config, services.clock, logger, () => {
    if (options.webhookSender?.autoStart !== false) webhooks.start();
  }, options.webhookManagement, { catalog: services.catalog, registry: services.registry });
  const mcp = createMcpEndpoint({
    publicUrl: config.publicUrl,
    allowedOrigins: config.allowedOrigins,
    tokens: services.tokens,
    clients: services.clients,
    tools: (options.tools ?? gatewayTools)(services),
    logger,
  });
  const router = createRouter([...oauthRoutes({ ...services, publicUrl: config.publicUrl, hosts: config.hosts }), mcp.route], logger);
  const engine = new JobEngine({
    config,
    store: services.jobs.store,
    registry: services.registry,
    catalog: services.catalog,
    clock: services.clock,
    logger,
    ...(options.jobEngine?.intervalMs === undefined ? {} : { intervalMs: options.jobEngine.intervalMs }),
    ...(options.jobEngine?.launchTimeoutMs === undefined ? {} : { launchTimeoutMs: options.jobEngine.launchTimeoutMs }),
  });
  services.jobs.wake = () => engine.wake();
  let dashboard: RunningDashboard | undefined;
  let checks: DashboardChecks | undefined;
  let server: RunningServer | undefined;
  let ready = false;
  try {
    // Reserve both listeners before applying routes. A failed second start must not rewrite the
    // subscription table shared with a serving process. MCP cannot act while setup is incomplete.
    server = await listen((req, res) => {
      if (!ready) { res.writeHead(503, { 'retry-after': '1' }); res.end(); return; }
      router(req, res);
    }, config.listen.host, options.port ?? config.listen.port);
    if (config.dashboard.enabled) {
      checks = new DashboardChecks({
        config, db: services.db, dataDir: options.dataDir, registry: services.registry, clock: services.clock, logger,
        ...(options.commandEnv ? { commandEnv: options.commandEnv } : {}),
      });
      const lastChecks = checks;
      dashboard = await startDashboard({
        dashboard: config.dashboard,
        checks,
        logger,
        management,
        jobs: services.jobs,
        available: () => ready,
        ...(options.dashboardPort === undefined ? {} : { port: options.dashboardPort }),
        sources: {
          config, db: services.db, clock: services.clock, registry: services.registry, store: services.jobs.store, engine, startedAt,
          mcpListen: `${config.listen.host}:${server.port}`, lastChecks: () => lastChecks.last, demoLabel: options.dashboardDemoLabel ?? null,
        },
      });
    }
    // Reconciliation validates every enabled secret before its atomic DB update. On failure both
    // reserved listeners close, and no engine, sender, renewal or startup probe has been started.
    services.webhooks.reconcile(config.webhooks, options.dataDir);
    ready = true;
    management.ready();
  } catch (error) {
    await management.stop();
    await Promise.allSettled([dashboard?.close(0), server?.close(0), mcp.close()]);
    await services.close();
    throw error;
  }
  for (const host of config.hosts) {
    if (services.registry.credentialStatus(host.id).state === 'missing') logger.warn('host.not_enrolled', { hostId: host.id });
  }
  const commandCheck = new AbortController();
  let renewal: RenewalLoop | undefined;
  // Probes are bounded and abortable; neither startup nor shutdown waits for them. Renewal starts after preflight.
  void Promise.allSettled(config.hosts.map((host) => services.registry.preflight(host.id, { signal: commandCheck.signal }))).then((results) => {
    if (commandCheck.signal.aborted) return;
    try {
      for (const [index, result] of results.entries()) {
        const hostId = config.hosts[index]!.id;
        if (result.status === 'rejected') {
          logger.error('host.pairing_preflight_failed', { hostId });
          continue;
        }
        for (const check of result.value) {
          logger[check.level === 'fail' ? 'error' : check.level === 'warn' ? 'warn' : 'info']('host.pairing_preflight', {
            hostId, checkCode: check.code,
          });
        }
      }
    } finally {
      // Unexpected diagnostic failures must not disable renewal. Logger errors still propagate.
      if (!commandCheck.signal.aborted) renewal = startRenewalLoop(services.registry, config.renewal.checkEveryMinutes * MINUTE, logger);
    }
  });
  if (services.webhooks.listConnections().length && options.webhookSender?.autoStart !== false) webhooks.start();
  if (options.jobEngine?.autoStart !== false) engine.start();
  // Checked in the background: an unreachable host must not delay startup or shutdown. Logged as warnings.
  const modelCheck = new AbortController();
  void warnProjectsWithoutModel(config, services.registry, logger, modelCheck.signal);
  const reachability = options.reachability?.autoStart === false ? undefined
    : startReachabilityLoop(services.registry, config.reachability.intervalMinutes * MINUTE);
  logger.info('gateway.started', { listen: `${config.listen.host}:${server.port}`, publicUrl: config.publicUrl, hosts: config.hosts.length });
  let closing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    logger.info('gateway.stopping');
    ready = false;
    const stoppedManagement = management.stop();
    const stoppedReachability = reachability?.stop();
    // Not awaited: a startup model call still in flight ends when the T3 clients close below.
    modelCheck.abort();
    commandCheck.abort();
    await dashboard?.close();
    await stoppedManagement;
    await stoppedReachability;
    await server!.close();
    // The engine finishes its current tick; job state is already in the database.
    await engine.stop();
    await webhooks.stop();
    await renewal?.stop();
    await mcp.close();
    await services.close();
    logger.info('gateway.stopped');
  };
  return {
    services,
    engine,
    webhooks,
    port: server.port,
    dashboard: dashboard && checks ? { port: dashboard.port, path: dashboard.path, checks } : null,
    close: () => (closing ??= shutdown()),
  };
}
