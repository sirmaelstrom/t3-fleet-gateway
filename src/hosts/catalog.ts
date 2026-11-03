import { randomBytes } from 'node:crypto';
import * as z from 'zod';

import { silentLogger, type Logger } from '../log.ts';

import { GatewayError } from '../errors.ts';
import type { T3Capabilities, T3Project } from '../t3/schemas.ts';
import { SECOND, type Clock } from '../time.ts';
import type { HostRegistry } from './registry.ts';

/** How long a host's catalog answers agents from memory before it is read from T3 again. */
export const CATALOG_TTL_MS = 30 * SECOND;
/** Bounds on a host's model catalog. Beyond any of them the catalog is `catalog_limit`: never a partial one. */
export const MAX_PROVIDERS = 100;
export const MAX_MODELS = 2000;
export const MAX_OPTIONS_PER_MODEL = 64;
export const MAX_CHOICES_PER_OPTION = 256;
/** The sanitized catalog's JSON size, in characters (UTF-16 code units). */
export const MAX_CATALOG_CHARS = 1_000_000;

/** A T3 project as agents see it: id and name only, never workspace paths, scripts or other project settings. */
export interface CatalogProject {
  id: string;
  name: string;
  /** Whether T3 launches in this project with a model of the project's own when none is passed. */
  hasDefaultModel: boolean;
  pinned?: boolean | null;
  archived?: boolean | null;
}

export interface CatalogChoice {
  id: string;
  label: string;
  description: string | null;
  isDefault: boolean;
}

/**
 * A normalized model option. Only `select` and `boolean` are selectable; unknown explicit types are metadata.
 */
export interface CatalogOption {
  id: string;
  label: string;
  description: string | null;
  type: string;
  choices: CatalogChoice[] | null;
  currentValue: string | boolean | null;
}

export interface CatalogModel {
  id: string;
  label: string | null;
  options: CatalogOption[];
}

export interface CatalogProvider {
  providerInstanceId: string;
  driverKind: string;
  displayName: string | null;
  models: CatalogModel[];
  omittedModels: number;
  runtimeModes: string[] | null;
  /** T3's own flags about delegated child tasks: metadata, not proof that a top-level launch works. */
  canRunChildTask: boolean | null;
  canRunCrossProviderChildTask: boolean | null;
  constraints: string[];
}

/**
 * A completed, sanitized read of one host's catalog. `id` is random and unique to this read (96 bits):
 * a page cursor names it, so a cursor minted against an earlier read, or before a gateway restart,
 * never pages a different snapshot (a counter would start again at 1 in a new process).
 */
export interface Snapshot<T> {
  id: string;
  fetchedAt: number;
  value: T;
}

export function snapshotId(): string {
  return randomBytes(12).toString('base64url');
}

export type CatalogKind = 'projects' | 'models';

interface Entry<T> {
  snapshot?: Snapshot<T>;
  inflight?: Promise<Snapshot<T>>;
  search?: string;
}

function limit(hostId: string, what: string): GatewayError {
  return new GatewayError('catalog_limit', `Host ${hostId} advertises more ${what} than the gateway handles; its catalog is unavailable.`);
}

const choiceSchema = z.object({
  id: z.string().min(1), label: z.string().optional(), description: z.string().nullish(), isDefault: z.boolean().nullish(),
});
const rawOptionSchema = z.object({
  id: z.string().min(1), label: z.string().nullish(), name: z.string().nullish(), displayName: z.string().nullish(),
  description: z.string().nullish(), type: z.string().nullish(),
  options: z.array(choiceSchema).nullish(), choices: z.array(choiceSchema).nullish(),
  // T3 PR #22889 compact descriptors: values are choice ids or [false, true].
  values: z.union([z.array(z.string().min(1)), z.array(z.boolean())]).optional(),
  default: z.union([z.string(), z.boolean()]).optional(), currentValue: z.union([z.string(), z.boolean()]).nullish(),
});
const rawModelSchema = z.object({ id: z.string().min(1), label: z.string().nullish(), options: z.array(z.unknown()).nullish() });

function sanitizeOption(raw: unknown, hostId: string): CatalogOption | null {
  // Check raw collection lengths before parsing, so malformed entries cannot evade limits.
  if (raw && typeof raw === 'object') {
    for (const key of ['options', 'choices', 'values']) {
      const value = Reflect.get(raw, key);
      if (Array.isArray(value) && value.length > MAX_CHOICES_PER_OPTION) throw limit(hostId, 'choices for one model option');
    }
  }
  const parsed = rawOptionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const descriptor = parsed.data;
  const listed = descriptor.options ?? descriptor.choices;
  const values = descriptor.values;
  if (values?.length === 0) return null;
  const currentValue = descriptor.currentValue ?? descriptor.default ?? null;
  const inferred = listed || (values && values.every((value) => typeof value === 'string')) ? 'select'
    : (values?.length && values.every((value) => typeof value === 'boolean')) || typeof currentValue === 'boolean' ? 'boolean' : null;
  const type = descriptor.type ?? inferred;
  if (!type) return null;
  if (values && ((type === 'select' && values.some((value) => typeof value !== 'string'))
    || (type === 'boolean' && values.some((value) => typeof value !== 'boolean')))) return null;
  // A boolean descriptor with a restricted values list cannot safely be represented as an unrestricted toggle.
  if (type === 'boolean' && values && (!values.some((value) => value === false) || !values.some((value) => value === true))) return null;
  const choices: z.infer<typeof choiceSchema>[] | null = type === 'select' ? (listed ?? (values ?? []).filter((value): value is string => typeof value === 'string').map((id) => ({ id }))) : null;
  return {
    id: descriptor.id,
    label: descriptor.label ?? descriptor.displayName ?? descriptor.name ?? descriptor.id,
    description: descriptor.description ?? null,
    type,
    choices: choices && choices.map((choice) => ({
      id: choice.id, label: choice.label ?? choice.id,
      description: choice.description ?? null,
      isDefault: choice.isDefault === true || choice.id === descriptor.default,
    })),
    currentValue,
  };
}

/** The whitelisted catalog of providers and models from a T3 capabilities answer, or `catalog_limit`. */
export function sanitizeCapabilities(hostId: string, capabilities: T3Capabilities, logger: Logger = silentLogger): CatalogProvider[] {
  if (capabilities.providers.length > MAX_PROVIDERS) throw limit(hostId, 'providers');
  let models = 0;
  const providers = capabilities.providers.map((provider): CatalogProvider => {
    models += provider.models.length;
    if (models > MAX_MODELS) throw limit(hostId, 'models');
    return {
      providerInstanceId: provider.providerInstanceId,
      driverKind: provider.driverKind,
      displayName: provider.displayName ?? null,
      models: provider.models.flatMap((raw) => {
        if (raw && typeof raw === 'object') {
          const options = Reflect.get(raw, 'options');
          if (Array.isArray(options) && options.length > MAX_OPTIONS_PER_MODEL) throw limit(hostId, 'options for one model');
        }
        const parsed = rawModelSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn('catalog.model_skipped', { hostId });
          return [];
        }
        const model = parsed.data;
        let skipped = 0;
        const options = (model.options ?? []).flatMap((option) => {
          const sanitized = sanitizeOption(option, hostId);
          if (!sanitized) { skipped++; return []; }
          return [sanitized];
        });
        if (skipped) logger.warn('catalog.options_skipped', { hostId, count: skipped });
        return [{ id: model.id, label: model.label ?? null, options }];
      }),
      omittedModels: provider.omittedModels ?? 0,
      runtimeModes: provider.runtimeModes ?? null,
      canRunChildTask: provider.canRunChildTask ?? null,
      canRunCrossProviderChildTask: provider.canRunCrossProviderChildTask ?? null,
      constraints: provider.constraints ?? [],
    };
  });
  if (JSON.stringify(providers).length > MAX_CATALOG_CHARS) throw limit(hostId, 'catalog text');
  return providers;
}

export function sanitizeProjects(hostId: string, projects: readonly T3Project[]): CatalogProject[] {
  const sanitized = projects.map((project) => ({
    id: project.id,
    name: project.title,
    pinned: project.pinnedAt === undefined ? null : project.pinnedAt !== null,
    archived: project.archivedAt === undefined ? null : project.archivedAt !== null,
    hasDefaultModel: project.defaultModelSelection !== undefined && project.defaultModelSelection !== null,
  }));
  if (JSON.stringify(sanitized).length > MAX_CATALOG_CHARS) throw limit(hostId, 'project catalog text');
  return sanitized;
}

/**
 * Per-host catalogs of T3 projects and model capabilities for agents, read from T3 on demand only
 * (never on a timer): a completed sanitized snapshot answers for CATALOG_TTL_MS, concurrent readers
 * share one in-flight read, and a failed read is thrown to its callers and replaces nothing. The
 * caller authorizes the host before asking. Snapshots are whitelisted copies; no T3 answer is kept.
 */
export class CatalogService {
  readonly #registry: HostRegistry;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #projects = new Map<string, Entry<CatalogProject[]>>();
  readonly #models = new Map<string, Entry<CatalogProvider[]>>();

  constructor(registry: HostRegistry, clock: Clock, logger: Logger = silentLogger) {
    this.#registry = registry;
    this.#clock = clock;
    this.#logger = logger;
  }

  projects(hostId: string, options: { refresh?: boolean } = {}): Promise<Snapshot<CatalogProject[]>> {
    return this.#read(this.#projects, hostId, 'projects', options.refresh === true, async () =>
      sanitizeProjects(hostId, await this.#registry.client(hostId).listProjects()),
    );
  }

  models(hostId: string, options: { refresh?: boolean; search?: string } = {}): Promise<Snapshot<CatalogProvider[]>> {
    return this.#read(this.#models, hostId, 'models', options.refresh === true, async () =>
      sanitizeCapabilities(hostId, await this.#registry.client(hostId).readCapabilities({ search: options.search }), this.#logger),
      options.search,
    );
  }

  /** The snapshot held for a host, however old: a page cursor continues from the snapshot it names. */
  held(hostId: string, kind: CatalogKind, search?: string): Snapshot<CatalogProject[]> | Snapshot<CatalogProvider[]> | undefined {
    if (kind === 'projects') return this.#projects.get(hostId)?.snapshot;
    const entry = this.#models.get(hostId);
    return (entry?.search ?? '') === (search ?? '') ? entry?.snapshot : undefined;
  }

  #read<T>(entries: Map<string, Entry<T>>, hostId: string, kind: CatalogKind, refresh: boolean, fetch: () => Promise<T>, search?: string): Promise<Snapshot<T>> {
    this.#registry.host(hostId);
    let entry = entries.get(hostId);
    if (!entry || (entry.search ?? '') !== (search ?? '')) {
      entry = { search };
      entries.set(hostId, entry);
    }
    const now = this.#clock();
    if (!refresh && entry.snapshot && now - entry.snapshot.fetchedAt < CATALOG_TTL_MS) return Promise.resolve(entry.snapshot);
    if (entry.inflight) return entry.inflight;
    const current = entry;
    const inflight = fetch()
      .then((value) => {
        const snapshot: Snapshot<T> = { id: snapshotId(), fetchedAt: this.#clock(), value };
        this.#registry.signals(hostId).record(kind);
        current.snapshot = snapshot;
        return snapshot;
      })
      .catch((error: unknown) => {
        this.#registry.signals(hostId).record(kind, error);
        throw error;
      })
      .finally(() => {
        if (current.inflight === inflight) current.inflight = undefined;
      });
    entry.inflight = inflight;
    return inflight;
  }
}

/**
 * An opaque page cursor bound to one host and one catalog snapshot (by its random id). A snapshot
 * replaced since, by a refresh, the TTL or a restart, is a fresh start: the cursor is refused.
 */
export interface PageCursor {
  hostId: string;
  kind: CatalogKind;
  snapshot: string;
  offset: number;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(`v2\n${cursor.kind}\n${cursor.hostId}\n${cursor.snapshot}\n${cursor.offset}`).toString('base64url');
}

export function decodeCursor(text: string): PageCursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(text)) return undefined;
  const parts = Buffer.from(text, 'base64url').toString('utf8').split('\n');
  if (parts.length !== 5 || parts[0] !== 'v2') return undefined;
  const [, kind, hostId, snapshot, offset] = parts;
  if ((kind !== 'projects' && kind !== 'models') || !hostId || !snapshot || !/^[A-Za-z0-9_-]{16}$/.test(snapshot) || !/^\d{1,15}$/.test(offset ?? '')) return undefined;
  return { kind, hostId, snapshot, offset: Number(offset) };
}
