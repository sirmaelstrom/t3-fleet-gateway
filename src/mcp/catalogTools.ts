import type { JobService } from '../jobs/service.ts';
import * as z from 'zod';
import type { GatewayConfig, HostConfig } from '../config.ts';
import { describeError, GatewayError } from '../errors.ts';
import {
  decodeCursor,
  encodeCursor,
  MAX_CHOICES_PER_OPTION,
  MAX_MODELS,
  MAX_OPTIONS_PER_MODEL,
  MAX_PROVIDERS,
  type CatalogKind,
  type CatalogProject,
  type CatalogProvider,
  type CatalogService,
  type Snapshot,
} from '../hosts/catalog.ts';
import { MAX_PROJECT_PAGES, PROJECT_PAGE_SIZE } from '../t3/client.ts';
import { effectivePolicy, launchPolicy, mapProjects, type EffectivePolicy } from '../jobs/targets.ts';
import { permits, READ_SCOPE } from '../oauth/scopes.ts';
import { isoTime } from '../time.ts';
import { defineTool, type ToolContext } from './tools.ts';

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;

const inputSchema = z.object({
  host: z.string().min(1).max(32).optional().describe('One host id (from fleet_status). Omit it to read every host you may read, each with its own first page'),
  refresh: z.boolean().optional().describe('Read the host again now instead of answering from the last read (kept for 30 seconds). Not with cursor'),
  cursor: z.string().min(1).max(512).optional().describe('nextCursor from a previous call for the same host; needs host'),
  limit: z.int().min(1).max(MAX_PAGE).optional().describe(`Items per host per page, default ${DEFAULT_PAGE}, at most ${MAX_PAGE}`),
});

const modelsInputSchema = inputSchema.extend({
  search: z.string().trim().min(1).max(200).optional().describe('Search model ids and labels beyond T3’s default short list. Repeat with cursor; narrow the query when omittedModels is nonzero'),
});

const errorSchema = z.object({ code: z.string(), message: z.string() });

const hostBase = {
  host: z.string(),
  discovery: z.boolean().describe('Whether the operator enabled discovery on this host. false: nothing was read from it'),
  available: z.boolean().describe('The catalog was read: items, nextCursor and total are meaningful. false: see error'),
  error: errorSchema.nullable().describe('discovery_disabled, host_unreachable, host_not_enrolled, catalog_limit (too large to enumerate) or another code'),
  readAt: z.string().nullable().describe('When the catalog this page comes from was read from T3 (ISO 8601)'),
  nextCursor: z.string().nullable().describe('Pass as cursor with this host for the next page; null on the last page'),
  total: z.int().nullable().describe('Items in the whole catalog of this host'),
};

const launchSchema = z.object({
  allowed: z.boolean().describe('Whether work_start may launch here right now'),
  source: z.enum(['alias', 'discovered', 'ambiguous']).describe(
    "alias: a configured project's settings apply (allowWorkStart, runtimeMode, baseRef, branchPrefix, model); discovered: the host's discovery policy " +
      'applies; ambiguous: several configured aliases match, name the alias you mean',
  ),
  alias: z.string().nullable().describe('The configured alias to pass as project; null when none (use target) or ambiguous'),
  aliases: z.array(z.string()).describe('Every configured alias that maps to this project'),
  runtimeMode: z.string().nullable(),
  workspaceMode: z.enum(['scratch', 'worktree']).nullable(),
  baseRef: z.string().nullable(),
  branchPrefix: z.string().nullable(),
  defaultModelSource: z.enum(['explicit', 'project', 'host', 't3_default']).nullable().describe(
    'Where a launch without modelSelection gets its model: project or host config, or the T3 project default. null: none; pass modelSelection',
  ),
});

const projectSchema = z.object({
  host: z.string(),
  projectId: z.string().describe('The T3 project id: pass it as target.projectId with the host to work_start when launch.alias is null'),
  name: z.string().describe('The T3 project title; projects on different hosts may share a name, the host and id tell them apart'),
  hasDefaultModel: z.boolean().describe('Whether T3 launches here with a model of its own when none is passed'),
  pinned: z.boolean().nullable().describe('Pinned in T3; null when an older host does not report project organization'),
  archived: z.boolean().nullable().describe('Archived in T3; null when unknown. Organization metadata does not override operator launch policy'),
  launch: launchSchema,
  guidance: z.string().describe('How to start work here, or why you cannot'),
});

const projectsOutput = z.object({
  hosts: z.array(z.object({ ...hostBase, projects: z.array(projectSchema) })),
});

const choiceSchema = z.object({ id: z.string(), label: z.string(), description: z.string().nullable(), isDefault: z.boolean() });

const optionSchema = z.object({
  id: z.string().describe('The option id to use as a key in modelSelection.options'),
  label: z.string(),
  description: z.string().nullable(),
  type: z.string().describe("select: pass one of choices[].id; boolean: pass true or false. Any other type is listed but cannot be selected"),
  choices: z.array(choiceSchema).nullable().describe('The complete list of values a select option takes (T3 advertises them; nothing is omitted)'),
  currentValue: z.union([z.string(), z.boolean()]).nullable().describe("T3's current value where it reports one"),
});

const providerSchema = z.object({
  providerInstanceId: z.string().describe('Pass as modelSelection.instanceId'),
  driverKind: z.string(),
  displayName: z.string().nullable(),
  modelCount: z.int().describe('Number of models returned by T3 in this catalog or search'),
  omittedModels: z.int().nonnegative().describe('Models or search matches left out by T3; narrow search to find others. 0 on legacy hosts that report no omissions'),
  runtimeModes: z.array(z.string()).nullable().describe('Runtime modes T3 lists for the provider, when it does'),
  canRunChildTask: z.boolean().nullable().describe("T3's flag for delegated child tasks inside T3; not proof that a top-level launch works"),
  canRunCrossProviderChildTask: z.boolean().nullable(),
  constraints: z.array(z.string()).describe("T3's own notes on the provider, as metadata"),
});

const modelSchema = z.object({
  host: z.string(),
  providerInstanceId: z.string().describe('Pass as modelSelection.instanceId'),
  driverKind: z.string(),
  providerLabel: z.string().nullable(),
  modelId: z.string().describe('Pass as modelSelection.model'),
  modelLabel: z.string().nullable(),
  options: z.array(optionSchema).describe('The options this model advertises, such as a reasoning effort; pass chosen ones as modelSelection.options'),
  runtimeModes: z.array(z.string()).nullable(),
  constraints: z.array(z.string()),
});

const modelsOutput = z.object({
  hosts: z.array(z.object({ ...hostBase, providers: z.array(providerSchema), models: z.array(modelSchema) })),
});

type ProjectView = z.infer<typeof projectSchema>;
type ModelView = z.infer<typeof modelSchema>;
type ProviderView = z.infer<typeof providerSchema>;

interface Page<T> {
  items: T[];
  snapshot: Snapshot<unknown>;
  nextCursor: string | null;
  total: number;
}

export interface CatalogToolDeps {
  config: GatewayConfig;
  catalog: CatalogService;
  jobs: JobService;
}

/**
 * Which hosts a call reads: the named host, if the agent may read it (an unknown or unreadable host is
 * `not_found`, with no catalog access or metadata), else every readable host. A cursor needs the host.
 */
function targetHosts(deps: CatalogToolDeps, context: ToolContext, input: z.output<typeof inputSchema>): HostConfig[] {
  if (input.cursor !== undefined && input.host === undefined) throw new GatewayError('invalid_argument', 'A cursor continues one host: pass host with it.');
  if (input.cursor !== undefined && input.refresh === true) throw new GatewayError('invalid_argument', 'Pass refresh or cursor, not both.');
  if (input.host === undefined) return deps.config.hosts.filter((host) => permits(context.scopes, 'read', host.id));
  const host = deps.config.hosts.find((candidate) => candidate.id === input.host);
  if (!host || !permits(context.scopes, 'read', host.id)) throw new GatewayError('not_found', `No host "${input.host}". fleet_status lists the hosts you can use.`);
  return [host];
}

/**
 * One host's page of a catalog, in the order `items` lays the snapshot out. Authorization has happened.
 * A first page reads the catalog (from memory within the TTL, or from T3); a cursor pages the snapshot it
 * was issued for, however old, and is refused once that snapshot has been replaced.
 */
async function readPage<S, T>(
  deps: CatalogToolDeps,
  host: HostConfig,
  kind: CatalogKind,
  input: z.output<typeof modelsInputSchema>,
  read: (refresh: boolean) => Promise<Snapshot<S>>,
  items: (value: S) => T[],
): Promise<Page<T>> {
  const limit = input.limit ?? DEFAULT_PAGE;
  let snapshot: Snapshot<S>;
  let offset = 0;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor || cursor.kind !== kind || cursor.hostId !== host.id) {
      throw new GatewayError('invalid_argument', `That cursor is not from this tool for host ${host.id}. Start again without cursor.`);
    }
    const held = deps.catalog.held(host.id, kind, input.search) as Snapshot<S> | undefined;
    if (!held || held.id !== cursor.snapshot) {
      throw new GatewayError('invalid_argument', `That cursor's catalog of host ${host.id} has been replaced or expired. Start again without cursor.`);
    }
    snapshot = held;
    offset = cursor.offset;
  } else {
    snapshot = await read(input.refresh === true);
  }
  const all = items(snapshot.value);
  const total = all.length;
  const page = all.slice(offset, offset + limit);
  const end = offset + page.length;
  return {
    items: page,
    snapshot,
    total,
    nextCursor: end < total ? encodeCursor({ hostId: host.id, kind, snapshot: snapshot.id, offset: end }) : null,
  };
}

function unavailable(host: HostConfig, error: unknown) {
  const described = describeError(error);
  return {
    host: host.id,
    discovery: host.discovery.enabled,
    available: false,
    error: described.code === 'internal_error' ? { code: described.code, message: 'The gateway hit an unexpected error reading the catalog.' } : described,
    readAt: null,
    nextCursor: null,
    total: null,
  };
}

function disabled(host: HostConfig) {
  return {
    host: host.id,
    discovery: false,
    available: false,
    error: {
      code: 'discovery_disabled',
      message: `Discovery is not enabled on host ${host.id}. Its configured projects are in fleet_status; ask the operator to enable discovery for more.`,
    },
    readAt: null,
    nextCursor: null,
    total: null,
  };
}

/** How a launch into a named project gets its workspace, for the guidance text. */
function workspaceText(policy: EffectivePolicy, choosesWorkspace: boolean): string {
  if (policy.workspaceMode === 'scratch') return 'T3 internal scratch';
  return choosesWorkspace
    ? `the host picks the workspace: a repository gets a fresh worktree from the up-to-date remote ${policy.baseRef}, any other folder is used as it is; work_start workspace overrides`
    : `base ${policy.baseRef}`;
}

function guidance(project: CatalogProject, host: string, policy: EffectivePolicy, choosesWorkspace: boolean): string {
  if (policy.source === 'ambiguous') {
    return `Configured under aliases ${policy.aliases.join(', ')}: start work with work_start { project: <one of them> }, not with target.`;
  }
  const model = policy.defaultModelSource === null
    ? ' No default model: pass modelSelection (fleet_models).'
    : policy.defaultModelSource === 't3_default' ? " Without modelSelection, T3's project default model is used." : '';
  if (policy.source === 'alias') {
    if (!policy.allowWorkStart) {
      return `Configured as project "${policy.alias}", which does not accept work_start: send work to its standing jobs with work_continue (fleet_status lists them).`;
    }
    return `Start work with work_start { project: ${JSON.stringify(policy.alias)} } (${policy.runtimeMode}, ${workspaceText(policy, choosesWorkspace)}).${model}`;
  }
  if (!policy.allowWorkStart) {
    return `No configured alias, and host ${host} does not accept work_start into unconfigured projects. Ask the operator to configure it or to enable discovery launches.`;
  }
  return `Start work with work_start { target: { host: ${JSON.stringify(host)}, projectId: ${JSON.stringify(project.id)} } } (${policy.runtimeMode}, ${workspaceText(policy, choosesWorkspace)}).${model}`;
}

function projectViews(deps: CatalogToolDeps, host: HostConfig, projects: readonly CatalogProject[], all: readonly CatalogProject[]): ProjectView[] {
  const mappings = mapProjects(deps.config, host.id, all);
  return projects.map((project) => {
    const mapping = mappings.get(project.id)!;
    const policy = effectivePolicy(deps.config, launchPolicy(host, mapping), project);
    return {
      host: host.id,
      projectId: project.id,
      name: project.name,
      pinned: project.pinned ?? null,
      archived: project.archived ?? null,
      hasDefaultModel: project.hasDefaultModel,
      launch: {
        allowed: policy.allowWorkStart,
        source: policy.source,
        alias: policy.alias,
        aliases: policy.aliases,
        runtimeMode: policy.runtimeMode,
        workspaceMode: policy.workspaceMode,
        baseRef: policy.baseRef,
        branchPrefix: policy.branchPrefix,
        defaultModelSource: policy.defaultModelSource,
      },
      guidance: (project.archived ? 'Archived in T3. Check with the operator before starting new work. ' : '') + guidance(project, host.id, policy, host.workspaceProbeCommand !== undefined),
    };
  });
}

function describeProject(project: ProjectView): string {
  return `  ${project.projectId} ${JSON.stringify(project.name)}${project.pinned ? ' (pinned)' : ''}${project.archived ? ' (archived)' : ''}${project.hasDefaultModel ? '' : ' (no T3 default model)'}: ${project.guidance}`;
}

interface FlatModel {
  provider: CatalogProvider;
  model: CatalogProvider['models'][number];
}

function flatten(providers: readonly CatalogProvider[]): FlatModel[] {
  return providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
}

function modelView(host: string, entry: FlatModel): ModelView {
  return {
    host,
    providerInstanceId: entry.provider.providerInstanceId,
    driverKind: entry.provider.driverKind,
    providerLabel: entry.provider.displayName,
    modelId: entry.model.id,
    modelLabel: entry.model.label,
    options: entry.model.options,
    runtimeModes: entry.provider.runtimeModes,
    constraints: entry.provider.constraints,
  };
}

function providerView(provider: CatalogProvider): ProviderView {
  return {
    providerInstanceId: provider.providerInstanceId,
    driverKind: provider.driverKind,
    displayName: provider.displayName,
    modelCount: provider.models.length,
    omittedModels: provider.omittedModels,
    runtimeModes: provider.runtimeModes,
    canRunChildTask: provider.canRunChildTask,
    canRunCrossProviderChildTask: provider.canRunCrossProviderChildTask,
    constraints: provider.constraints,
  };
}

/** Every id and every choice, so a client that reads only text can build a valid modelSelection. */
function describeModel(model: ModelView): string {
  const options = model.options.map((option) => {
    if (option.type === 'boolean') return `${option.id} (boolean${option.currentValue === null ? '' : `, currently ${String(option.currentValue)}`})`;
    if (option.type === 'select') {
      const choices = (option.choices ?? []).map((choice) => `${choice.id}${choice.isDefault ? '*' : ''}`).join(', ');
      return `${option.id} (select: ${choices || 'no choices'}${option.currentValue === null ? '' : `; currently ${String(option.currentValue)}`})`;
    }
    return `${option.id} (${option.type}, not selectable)`;
  });
  return `  instanceId ${JSON.stringify(model.providerInstanceId)} model ${JSON.stringify(model.modelId)}${model.modelLabel ? ` "${model.modelLabel}"` : ''}` +
    `: ${options.length === 0 ? 'no options' : `options ${options.join('; ')}`}`;
}

function describeHostHeader(view: { host: string; available: boolean; error: { code: string; message: string } | null; total: number | null; nextCursor: string | null }, what: string): string {
  if (!view.available) return `${view.host}: ${what} unavailable (${view.error?.code}): ${view.error?.message}`;
  return `${view.host}: ${view.total} ${what}${view.nextCursor ? `, more on the next page (cursor ${view.nextCursor})` : ''}`;
}

export function catalogTools(deps: CatalogToolDeps) {
  const fleetProjects = defineTool({
    name: 'fleet_projects',
    title: 'Discover T3 projects',
    description:
      'List the T3 projects on hosts where the operator enabled discovery, with their stable project ids and names, so you can find ' +
      'a project that has no alias in fleet_status. Each entry says how to start work there: launch.alias names the configured ' +
      'alias to pass as project (its allowWorkStart, runtimeMode and model settings apply exactly as in fleet_status); with no alias, ' +
      'pass target { host, projectId } to work_start, if launch.allowed is true (the host must allow launches into unconfigured ' +
      'projects, and the project needs a model: hasDefaultModel, the host default, or your modelSelection from fleet_models). ' +
      'Projects with the same name on two hosts are different projects: always carry the host with the id. Hosts with discovery ' +
      'disabled, or that cannot be read right now, are listed as unavailable with an error code and never hide the others. Answers ' +
      `come from a read kept for 30 seconds; pass refresh to read T3 again. Pages of ${DEFAULT_PAGE} (at most ${MAX_PAGE}) per host; ` +
      'continue one host with host and its nextCursor. A cursor whose catalog was since replaced is refused: start again. Read-only.',
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema,
    outputSchema: projectsOutput,
    async run(input, context) {
      const hosts = await Promise.all(
        targetHosts(deps, context, input).map(async (host) => {
          if (!host.discovery.enabled) return { ...disabled(host), projects: [] as ProjectView[] };
          try {
            const page = await readPage(deps, host, 'projects', input, (refresh) => deps.catalog.projects(host.id, { refresh }), (value) => {
              const mappings = mapProjects(deps.config, host.id, value);
              return value.filter((p) => deps.jobs.allowsProject(context, host.id, null, p.id) ||
                mappings.get(p.id)!.aliases.some((a) => deps.jobs.allowsProject(context, host.id, a.alias, p.id)));
            });
            const all = (page.snapshot as Snapshot<CatalogProject[]>).value;
            return {
              host: host.id,
              discovery: true,
              available: true,
              error: null,
              readAt: isoTime(page.snapshot.fetchedAt),
              nextCursor: page.nextCursor,
              total: page.total,
              projects: projectViews(deps, host, page.items, all),
            };
          } catch (error) {
            if (error instanceof GatewayError && error.code === 'invalid_argument') throw error;
            return { ...unavailable(host, error), projects: [] as ProjectView[] };
          }
        }),
      );
      const summary = hosts.flatMap((view) => [describeHostHeader(view, 'T3 project(s)'), ...view.projects.map(describeProject)]).join('\n');
      return { structured: { hosts }, summary: summary || 'No hosts to read.' };
    },
  });

  const fleetModels = defineTool({
    name: 'fleet_models',
    title: 'Discover models and options',
    description:
      'List the provider instances, models and model options (such as a reasoning effort) each host advertises, on hosts where the ' +
      'operator enabled discovery, read live from that host\'s T3. Pass search to find models beyond its short default list; ' +
      'omittedModels counts matches T3 left out (narrow search). Older hosts return their legacy catalog. Use it to build a modelSelection for work_start: ' +
      'instanceId = providerInstanceId, model = modelId, and options = { <option id>: <a choices[].id for select options, true or ' +
      'false for boolean options> }. Only what a host advertises is accepted there; a selection the host does not advertise is refused ' +
      'rather than substituted, and omitting modelSelection keeps the configured defaults (project, then host, then the T3 project ' +
      'default). Providers that advertise no models are listed under providers with modelCount 0. canRunChildTask and constraints are ' +
      "T3's own metadata about delegated child tasks, not proof that a launch with that provider works. Unavailable hosts are listed " +
      `with an error code and never hide the others; answers come from a read kept for 30 seconds (refresh re-reads). Pages of ${DEFAULT_PAGE} ` +
      `models (at most ${MAX_PAGE}) per host; continue one host with host and its nextCursor. Catalogs beyond ${MAX_PROVIDERS} providers, ` +
      `${MAX_MODELS} models, ${MAX_OPTIONS_PER_MODEL} options per model or ${MAX_CHOICES_PER_OPTION} choices per option are reported as ` +
      `catalog_limit, never cut. Project catalogs stop at ${MAX_PROJECT_PAGES * PROJECT_PAGE_SIZE} projects the same way. Read-only.`,
    scope: READ_SCOPE,
    readOnly: true,
    inputSchema: modelsInputSchema,
    outputSchema: modelsOutput,
    async run(input, context) {
      const hosts = await Promise.all(
        targetHosts(deps, context, input).map(async (host) => {
          if (!host.discovery.enabled) return { ...disabled(host), providers: [] as ProviderView[], models: [] as ModelView[] };
          try {
            const page = await readPage(deps, host, 'models', input, (refresh) => deps.catalog.models(host.id, { refresh, search: input.search }), flatten);
            const providers = (page.snapshot as Snapshot<CatalogProvider[]>).value;
            return {
              host: host.id,
              discovery: true,
              available: true,
              error: null,
              readAt: isoTime(page.snapshot.fetchedAt),
              nextCursor: page.nextCursor,
              total: page.total,
              providers: providers.map(providerView),
              models: page.items.map((entry) => modelView(host.id, entry)),
            };
          } catch (error) {
            if (error instanceof GatewayError && error.code === 'invalid_argument') throw error;
            return { ...unavailable(host, error), providers: [] as ProviderView[], models: [] as ModelView[] };
          }
        }),
      );
      const summary = hosts
        .flatMap((view) => [
          describeHostHeader(view, 'model(s)'),
          ...view.providers.map(
            (provider) =>
              `  provider ${JSON.stringify(provider.providerInstanceId)} (${provider.driverKind}${provider.displayName ? `, ${provider.displayName}` : ''}): ` +
              `${provider.modelCount} model(s)${provider.omittedModels ? `, ${provider.omittedModels} omitted by T3; narrow search` : ''}${provider.runtimeModes ? `, runtime modes ${provider.runtimeModes.join(', ')}` : ''}` +
              `${provider.constraints.length > 0 ? `, constraints: ${provider.constraints.join('; ')}` : ''}`,
          ),
          ...view.models.map(describeModel),
        ])
        .join('\n');
      return { structured: { hosts }, summary: summary || 'No hosts to read.' };
    },
  });

  return [fleetProjects, fleetModels];
}
