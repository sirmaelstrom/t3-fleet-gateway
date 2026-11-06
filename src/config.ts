import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { GatewayError } from './errors.ts';
import { webhooksSchema } from './webhooks/config.ts';

/** Approval levels T3 accepts for an MCP client. Anything above read-only is also the runtime-mode ceiling. */
export const T3_ACCESS_LEVELS = ['read-only', 'approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;
export type T3Access = (typeof T3_ACCESS_LEVELS)[number];

export const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

const MINT_ARGS = ['auth', 'pairing', 'create', '--ttl', '5m', '--json'];
// On Windows the T3 installer's entrypoint is a .cmd shim, which execFile refuses to run without cmd.exe.
const DEFAULT_MINT_COMMAND = process.platform === 'win32'
  ? ['cmd.exe', '/d', '/c', join(homedir(), '.local', 'bin', 't3.cmd'), ...MINT_ARGS]
  : ['t3', ...MINT_ARGS];

const slug = (max: number) =>
  z
    .string()
    .regex(new RegExp(`^[a-z0-9][a-z0-9-]{0,${max - 1}}$`), 'use lowercase letters, digits and hyphens');

/** An origin-only URL: http is allowed only for loopback hosts. */
const originUrl = (what: string) =>
  z.string().transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: `${what} must be an absolute URL` });
      return z.NEVER;
    }
    const secureEnough = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
    if (!secureEnough) {
      ctx.addIssue({ code: 'custom', message: `${what} must use https (http is allowed only for loopback hosts)` });
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      ctx.addIssue({ code: 'custom', message: `${what} must be an origin with no path, query, fragment or credentials` });
    }
    return url.origin;
  });

/** A T3 `modelSelection` object, passed through as T3 expects it, for example `{ instanceId, model }`. */
const modelSelectionSchema = z.looseObject({ model: z.unknown() });

/**
 * Opt-in discovery of a host's T3 projects and model capabilities (fleet_projects, fleet_models), and
 * the policy for launching into a T3 project that has no configured alias. Off by default: with
 * `enabled` false the host's catalogs are never read for agents, `work_start` accepts only configured
 * aliases there, and no per-job model selection. `allowWorkStart` separately permits launches into
 * unconfigured projects; `runtimeMode`, `baseRef` and `branchPrefix` are the policy for those launches.
 */
const discoverySchema = z.strictObject({
  enabled: z.boolean().default(false),
  allowWorkStart: z.boolean().default(false),
  runtimeMode: z.enum(RUNTIME_MODES).default('approval-required'),
  baseRef: z.string().min(1).max(200).default('main'),
  branchPrefix: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9._/-]*$/, 'use letters, digits, dots, underscores, hyphens and slashes')
    .default('fleet/'),
});

export const DEFAULT_DISCOVERY: z.output<typeof discoverySchema> = {
  enabled: false,
  allowWorkStart: false,
  runtimeMode: 'approval-required',
  baseRef: 'main',
  branchPrefix: 'fleet/',
};

const hostSchema = z.strictObject({
  id: slug(32),
  label: z.string().min(1).max(80).optional(),
  /** How the gateway reaches this host, in the operator's words (for example "SSH tunnel"); shown on the dashboard, never checked. */
  transportNote: z.string().min(1).max(80).optional(),
  t3Url: originUrl('t3Url'),
  mintPairingCode: z.array(z.string().min(1)).min(1).default(DEFAULT_MINT_COMMAND),
  /** Operator asserts this exact argv is non-mutating; never inferred from the mint command. */
  mintPairingCodeProbe: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
  /**
   * Opts the host into automatic workspace selection for named projects: this exact argv is run (no shell) with one JSON
   * object on stdin and prints one JSON object (docs/configuration.md, "Workspace probe"). Without it, named projects
   * launch exactly as before: a fresh worktree on the project's baseRef, from the local branch.
   */
  workspaceProbeCommand: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
  access: z.enum(T3_ACCESS_LEVELS).default('auto'),
  maxConcurrentJobs: z.int().min(1).max(32).default(2),
  defaultModelSelection: modelSelectionSchema.nullable().default(null),
  defaultProject: z.string().min(1).max(64).optional(),
  discovery: discoverySchema.default(DEFAULT_DISCOVERY),
  /**
   * false: the fleet scopes (`fleet:read`, `fleet:operate`) do not cover this host, so only a grant naming it
   * (`host:<id>:read|operate`) reaches it. Fleet-wide grants keep every other host.
   */
  fleetScopes: z.boolean().default(true),
});

const projectSchema = z
  .strictObject({
    alias: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'use lowercase letters, digits, dots, underscores and hyphens'),
    description: z.string().max(500).default(''),
    host: z.string(),
    workspaceMode: z.enum(['scratch', 'worktree']).default('worktree'),
    t3ProjectId: z.string().min(1).optional(),
    t3ProjectTitle: z.string().min(1).optional(),
    baseRef: z.string().min(1).max(200).default('main'),
    branchPrefix: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9._/-]*$/, 'use letters, digits, dots, underscores, hyphens and slashes')
      .default('fleet/'),
    runtimeMode: z.enum(RUNTIME_MODES).default('approval-required'),
    modelSelection: modelSelectionSchema.nullable().default(null),
    /** false: agents cannot start new jobs here, only drive the project's standing jobs with work_continue. */
    allowWorkStart: z.boolean().default(true),
  })
  .refine((project) => (project.t3ProjectId === undefined) !== (project.t3ProjectTitle === undefined), {
    message: 'set exactly one of t3ProjectId or t3ProjectTitle',
  })
  .refine((project) => project.workspaceMode !== 'scratch' || project.t3ProjectId !== undefined, {
    message: 'scratch workspaceMode requires an explicit t3ProjectId pin',
  });

const LOOPBACK_LISTEN_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/** A Host header value the dashboard accepts: a lowercase DNS name or IP literal, with an optional port. */
const HOST_HEADER_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

/**
 * The private operator dashboard (docs/design.md, "Operator dashboard"). Off by default. It has a listener of its own,
 * never the MCP listener, so the tunnel that carries /mcp to agents never carries the dashboard.
 */
const dashboardSchema = z.strictObject({
  enabled: z.boolean().default(false),
  listen: z
    .strictObject({
      host: z.string().refine((host) => LOOPBACK_LISTEN_HOSTS.includes(host), {
        message: 'dashboard.listen.host must be a loopback address; publish it with a tailnet-only proxy such as tailscale serve',
      }),
      port: z.int().min(1).max(65535),
    })
    .default({ host: '127.0.0.1', port: 3791 }),
  /** The path the dashboard is served under, the same as the proxy's mount path: "/" or "/segment[/segment]". */
  basePath: z
    .string()
    .regex(/^\/(?:[a-z0-9][a-z0-9._-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,62}){0,3})?$/, 'use "/" or a path such as "/fleet" (lowercase, no trailing slash)')
    .default('/'),
  /** Host header values accepted besides the listener's own loopback address (DNS rebinding protection). */
  allowedHosts: z.array(z.string().regex(HOST_HEADER_PATTERN, 'use a lowercase host name with an optional port, no scheme or path')).max(16).default([]),
  /** Display names for agent clients, by client id (see clients list), for example a connector that registered as "Cursor". */
  clientLabels: z
    .record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'use a client id from clients list'), z.string().min(1).max(80))
    .refine((labels) => Object.keys(labels).length <= 100, { message: 'at most 100 client labels' })
    .default({}),
});

export const DEFAULT_DASHBOARD: z.output<typeof dashboardSchema> = {
  enabled: false,
  listen: { host: '127.0.0.1', port: 3791 },
  basePath: '/',
  allowedHosts: [],
  clientLabels: {},
};

const configSchema = z
  .strictObject({
    $schema: z.string().optional(),
    publicUrl: originUrl('publicUrl'),
    listen: z
      .strictObject({
        host: z.string().refine((host) => LOOPBACK_LISTEN_HOSTS.includes(host), {
          message: 'listen.host must be a loopback address; expose the gateway through a tunnel',
        }),
        port: z.int().min(1).max(65535),
      })
      .default({ host: '127.0.0.1', port: 3790 }),
    allowedOrigins: z.array(originUrl('allowedOrigins entry')).default([]),
    /** Private operator text prepended to work_start launches, never diagnostics or logs. */
    standingInstructions: z.string().trim().min(1).max(4000).optional(),
    hosts: z.array(hostSchema).min(1, 'configure at least one host'),
    projects: z.array(projectSchema).default([]),
    tokens: z
      .strictObject({
        accessTtlSeconds: z.int().min(60).max(7 * 86400).default(43200),
        refreshIdleTtlDays: z.int().min(1).max(365).default(90),
      })
      .default({ accessTtlSeconds: 43200, refreshIdleTtlDays: 90 }),
    renewal: z
      .strictObject({
        renewWhenDaysLeft: z.int().min(1).max(29).default(5),
        checkEveryMinutes: z.int().min(1).max(1440).default(60),
        alertDaysLeft: z.array(z.int().min(1).max(29)).min(1).max(8).default([7, 2]),
      })
      .default({ renewWhenDaysLeft: 5, checkEveryMinutes: 60, alertDaysLeft: [7, 2] }),
    reachability: z
      .strictObject({ intervalMinutes: z.int().min(1).max(60).default(5) })
      .default({ intervalMinutes: 5 }),
    watcher: z
      .strictObject({
        pollSeconds: z.int().min(2).max(300).default(10),
        reconcileWindowMinutes: z.int().min(1).max(240).default(10),
      })
      .default({ pollSeconds: 10, reconcileWindowMinutes: 10 }),
    dashboard: dashboardSchema.default(DEFAULT_DASHBOARD),
    webhooks: webhooksSchema.default({ subscriptions: [] }),
  })
  .superRefine((config, ctx) => {
    // One port for both would put the dashboard behind the tunnel that carries /mcp to agents.
    if (config.dashboard.enabled && config.dashboard.listen.port === config.listen.port) {
      ctx.addIssue({
        code: 'custom',
        path: ['dashboard', 'listen', 'port'],
        message: 'dashboard.listen.port must differ from listen.port: the dashboard never shares the MCP listener',
      });
    }
    const hostIds = new Set<string>();
    config.hosts.forEach((host, index) => {
      if (hostIds.has(host.id)) ctx.addIssue({ code: 'custom', path: ['hosts', index, 'id'], message: `duplicate host id "${host.id}"` });
      hostIds.add(host.id);
      if (host.discovery.allowWorkStart && !host.discovery.enabled) {
        ctx.addIssue({
          code: 'custom',
          path: ['hosts', index, 'discovery', 'allowWorkStart'],
          message: 'discovery.allowWorkStart needs discovery.enabled true',
        });
      }
      // Browsing a read-only host is fine; only launches need a runtime mode the host allows.
      if (host.discovery.allowWorkStart && !runtimeModeAllowed(host.discovery.runtimeMode, host.access)) {
        ctx.addIssue({
          code: 'custom',
          path: ['hosts', index, 'discovery', 'runtimeMode'],
          message: `discovery.runtimeMode "${host.discovery.runtimeMode}" exceeds host "${host.id}" access "${host.access}"`,
        });
      }
    });
    config.hosts.forEach((host, index) => {
      if (host.defaultProject === undefined) return;
      const project = config.projects.find((candidate) => candidate.alias === host.defaultProject);
      if (!project || project.host !== host.id || project.workspaceMode !== 'scratch') {
        ctx.addIssue({ code: 'custom', path: ['hosts', index, 'defaultProject'], message: 'defaultProject must name a configured scratch alias on this host' });
      }
    });
    // A scratch pin is T3's scratch project: a worktree alias on the same id would put branches there and make a launch's policy depend on which alias is named.
    config.projects.forEach((project, index) => {
      if (project.workspaceMode !== 'scratch') return;
      const shared = config.projects.find((other) => other !== project && other.workspaceMode !== 'scratch' && other.host === project.host && other.t3ProjectId === project.t3ProjectId);
      if (shared) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', index, 't3ProjectId'],
          message: `scratch alias "${project.alias}" shares its pinned T3 project with non-scratch alias "${shared.alias}" on host "${project.host}"; a scratch pin must be used by scratch aliases only`,
        });
      }
    });
    const aliases = new Set<string>();
    config.projects.forEach((project, index) => {
      if (aliases.has(project.alias)) {
        ctx.addIssue({ code: 'custom', path: ['projects', index, 'alias'], message: `duplicate project alias "${project.alias}"` });
      }
      aliases.add(project.alias);
      const host = config.hosts.find((candidate) => candidate.id === project.host);
      if (!host) {
        ctx.addIssue({ code: 'custom', path: ['projects', index, 'host'], message: `unknown host "${project.host}"` });
        return;
      }
      if (!runtimeModeAllowed(project.runtimeMode, host.access)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', index, 'runtimeMode'],
          message: `runtimeMode "${project.runtimeMode}" exceeds host "${host.id}" access "${host.access}"`,
        });
      }
    });
  });

export type GatewayConfig = z.infer<typeof configSchema>;
export type HostConfig = GatewayConfig['hosts'][number];
export type ProjectConfig = GatewayConfig['projects'][number];
export type DashboardConfig = GatewayConfig['dashboard'];

/** Where a project's launches get their model in the gateway config, or null to leave it to the T3 project's default. */
export function configuredModel(config: GatewayConfig, project: ProjectConfig): { source: 'project' | 'host'; selection: Record<string, unknown> } | null {
  if (project.modelSelection) return { source: 'project', selection: project.modelSelection };
  const host = config.hosts.find((candidate) => candidate.id === project.host);
  return host?.defaultModelSelection ? { source: 'host', selection: host.defaultModelSelection } : null;
}

/** T3 caps a client's runtime modes at its approval level; read-only clients cannot launch work. */
export function runtimeModeAllowed(mode: RuntimeMode, access: T3Access): boolean {
  if (access === 'read-only') return false;
  return RUNTIME_MODES.indexOf(mode) <= RUNTIME_MODES.indexOf(access);
}

export function parseConfig(input: unknown): GatewayConfig {
  const result = configSchema.safeParse(input);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    if (issue.path[0] === 'webhooks') return '  webhooks: invalid webhook configuration';
    const path = issue.path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join('');
    return `  ${path.replace(/^\./, '') || '(root)'}: ${issue.message}`;
  });
  throw new GatewayError('config_invalid', `Invalid configuration:\n${problems.join('\n')}`);
}

export function loadConfig(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GatewayError('config_not_found', `No config file at ${path}. Copy config.example.json there and edit it.`);
    }
    throw new GatewayError('config_invalid', `Cannot read config file ${path}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GatewayError('config_invalid', `Config file ${path} is not valid JSON`);
  }
  return parseConfig(json);
}

export interface Paths {
  configPath: string;
  dataDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv, overrides: Partial<Paths> = {}): Paths {
  return {
    configPath: overrides.configPath ?? env.T3FG_CONFIG ?? join(homedir(), '.config', 't3-fleet-gateway', 'config.json'),
    dataDir: overrides.dataDir ?? env.T3FG_DATA_DIR ?? join(homedir(), '.local', 'share', 't3-fleet-gateway'),
  };
}

/** The canonical resource identifier agents' tokens are bound to. */
export function mcpResource(config: GatewayConfig): string {
  return `${config.publicUrl}/mcp`;
}
