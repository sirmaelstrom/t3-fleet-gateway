import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';
import { RUNTIME_MODE_VALUES } from '../../src/t3/schemas.ts';

export type AdvertisedTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

/** The downstream calls in src/t3/client.ts, including mutations inspected but never executed by the check. */
export const REQUIRED_TOOLS = [
  't3_environment_read', 't3_project_list', 'orchestrator_capabilities', 't3_thread_launch', 't3_thread_read', 't3_thread_list',
  't3_thread_search', 't3_thread_send', 't3_thread_interrupt', 't3_pending_request_list',
  't3_pending_request_read', 't3_pending_request_respond', 't3_pending_request',
] as const;

const OPTIONAL_TOOLS = ['t3_thread_organize'] as const;

/** Prefer the combined tool, otherwise require every legacy action. Check optional mutations when advertised. */
function requiredTools(indexed: ReadonlyMap<string, AdvertisedTool>) {
  return [
    ...REQUIRED_TOOLS.filter((name) => indexed.has('t3_pending_request')
      ? !name.startsWith('t3_pending_request_') : name !== 't3_pending_request'),
    ...OPTIONAL_TOOLS.filter((name) => indexed.has(name)),
  ];
}

export type Contract = Record<string, { inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>;
export type ContractChange = { tool: string; kind: 'added' | 'removed' | 'changed'; paths: string[] };
export type InputCheck = { tool: string; status: 'pass' | 'warn' | 'fail'; code: string };

const ANNOTATIONS = new Set(['title', 'description', 'examples', '$comment']);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_VALUES = new Set([
  'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames',
  'contains', 'not', 'if', 'then', 'else', 'contentSchema',
]);
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sort data object keys, preserving all data keys and array order (notably inside const/enum). */
function canonicalData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalData);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalData(value[key])]));
}

function sortedValues(values: unknown[]): unknown[] {
  return values.map(canonicalData).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Normalize only known schema locations: a property named "description" is still a real property. */
function canonicalSchema(value: unknown): unknown {
  if (!isObject(value)) return canonicalData(value);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !ANNOTATIONS.has(key)).map((key) => {
    const child = value[key];
    let normalized: unknown;
    if (SCHEMA_MAPS.has(key) && isObject(child)) {
      normalized = Object.fromEntries(Object.keys(child).sort().map((name) => [name, canonicalSchema(child[name])]));
    } else if (SCHEMA_VALUES.has(key)) {
      normalized = canonicalSchema(child);
    } else if (SCHEMA_ARRAYS.has(key) && Array.isArray(child)) {
      // Keep order: JSON Pointer references can address an indexed subschema, even in allOf/anyOf.
      normalized = child.map(canonicalSchema);
    } else if (key === 'items') {
      normalized = Array.isArray(child) ? child.map(canonicalSchema) : canonicalSchema(child);
    } else if ((key === 'required' || key === 'type' || key === 'enum') && Array.isArray(child)) {
      normalized = sortedValues(child);
    } else if ((key === 'dependencies' || key === 'dependentRequired') && isObject(child)) {
      normalized = Object.fromEntries(Object.keys(child).sort().map((name) => {
        const dependency = child[name];
        return [name, Array.isArray(dependency) ? sortedValues(dependency) : canonicalSchema(dependency)];
      }));
    } else {
      normalized = canonicalData(child);
    }
    return [key, normalized];
  }));
}

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Exact schema locations inspected by the safety guard, excluding annotation and literal data. */
function schemaNodes(schema: unknown): Map<string, unknown> {
  const nodes = new Map<string, unknown>();
  function visit(value: unknown, pointer: string): void {
    nodes.set(pointer, value);
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const location = `${pointer}/${pointerPart(key)}`;
      if ((SCHEMA_MAPS.has(key) || key === 'dependencies') && isObject(child)) {
        for (const [name, subschema] of Object.entries(child)) {
          if (key !== 'dependencies' || !Array.isArray(subschema)) visit(subschema, `${location}/${pointerPart(name)}`);
        }
      } else if (SCHEMA_VALUES.has(key)) {
        visit(child, location);
      } else if ((SCHEMA_ARRAYS.has(key) || key === 'items') && Array.isArray(child)) {
        child.forEach((subschema, index) => visit(subschema, `${location}/${index}`));
      } else if (key === 'items') {
        visit(child, location);
      }
    }
  }
  visit(schema, '');
  return nodes;
}

/**
 * A $ref can activate data beneath examples/const/enum as a schema. Only allow
 * root-local pointers to nodes the guard visits. Dynamic, anchor, external and nested-resource
 * resolution need a fuller reference resolver; keep those contracts unverified instead.
 */
function hasUnsupportedReferences(nodes: ReadonlyMap<string, unknown>): boolean {
  const references: unknown[] = [];
  let nestedResource = false;
  for (const [pointer, node] of nodes) {
    if (!isObject(node)) continue;
    if (Object.hasOwn(node, '$dynamicRef') || Object.hasOwn(node, '$recursiveRef')) return true;
    if (pointer !== '' && Object.hasOwn(node, '$id')) nestedResource = true;
    if (Object.hasOwn(node, '$ref')) references.push(node.$ref);
  }
  if (references.length && nestedResource) return true;
  return references.some((reference) => {
    if (typeof reference !== 'string' || !reference.startsWith('#')) return true;
    try {
      const pointer = decodeURIComponent(reference.slice(1));
      if (pointer !== '' && !pointer.startsWith('/')) return true;
      // Reject malformed pointer escapes; URI escapes above do not replace JSON Pointer escapes.
      if (/~(?:[^01]|$)/u.test(pointer)) return true;
      const target = nodes.get(pointer);
      return !nodes.has(pointer) || (!isObject(target) && typeof target !== 'boolean');
    } catch {
      return true;
    }
  });
}

function snapshotSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // Retain the entire raw structure when a ref could activate data we would otherwise strip/sort.
  return (hasUnsupportedReferences(schemaNodes(schema)) ? canonicalData(schema) : canonicalSchema(schema)) as Record<string, unknown>;
}

function indexTools(tools: readonly AdvertisedTool[]): Map<string, AdvertisedTool> {
  const indexed = new Map<string, AdvertisedTool>();
  for (const tool of tools) {
    if (indexed.has(tool.name)) throw new Error('duplicate_tool');
    indexed.set(tool.name, tool);
  }
  return indexed;
}

/** Only the gateway's dependencies belong in the baseline; unrelated new T3 tools are harmless. */
export function snapshotContract(tools: readonly AdvertisedTool[]): Contract {
  const indexed = indexTools(tools);
  return Object.fromEntries([...requiredTools(indexed)].sort().flatMap((name) => {
    const tool = indexed.get(name);
    if (!tool) return [];
    return [[name, {
      inputSchema: snapshotSchema(tool.inputSchema),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: snapshotSchema(tool.outputSchema) }),
    }]];
  }));
}

function changedPaths(before: unknown, after: unknown, path: string, paths: string[]): void {
  if (paths.length >= 20 || JSON.stringify(before) === JSON.stringify(after)) return;
  // Arrays and literal values are one change; never turn const/enum data into displayed paths.
  if (!isObject(before) || !isObject(after) || path.endsWith('/const') || path.endsWith('/default') || path.length > 200) {
    paths.push(path.length > 240 ? `${path.slice(0, 237)}...` : path);
    return;
  }
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    changedPaths(before[key], after[key], `${path}/${pointerPart(key)}`, paths);
    if (paths.length >= 20) break;
  }
}

/** These are contract changes requiring inspection, not a claim that every change breaks the gateway. */
export function compareContracts(before: Contract, after: Contract): ContractChange[] {
  const changes: ContractChange[] = [];
  for (const tool of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!Object.hasOwn(before, tool)) changes.push({ tool, kind: 'added', paths: [] });
    else if (!Object.hasOwn(after, tool)) changes.push({ tool, kind: 'removed', paths: [] });
    else {
      const paths: string[] = [];
      changedPaths(before[tool], after[tool], '', paths);
      if (paths.length) changes.push({ tool, kind: 'changed', paths });
    }
  }
  return changes;
}

const THREAD_ID = 'mcp:00000000-0000-4000-8000-000000000001';
const PROJECT_ID = 'mcp:00000000-0000-4000-8000-000000000002';
const REQUEST_ID = `runtime-request:provider:codex:provider-turn:${'x'.repeat(200)}`;
const CLIENT_REQUEST_ID = 't3fg-synthetic-compatibility';
const LAUNCH = {
  projectId: PROJECT_ID,
  title: 'Synthetic compatibility sample',
  workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'fleet/synthetic', startFromOrigin: false },
  message: 'Synthetic compatibility sample; never sent.',
};

/** Sample requests, not exhaustive schema compatibility proof. None of these are sent to a host. */
const INPUT_SAMPLES: Record<(typeof REQUIRED_TOOLS)[number] | (typeof OPTIONAL_TOOLS)[number], Record<string, unknown>[]> = {
  t3_environment_read: [{}],
  t3_project_list: [{ limit: 100 }, { limit: 100, cursor: 100 }],
  orchestrator_capabilities: [{}],
  t3_thread_launch: RUNTIME_MODE_VALUES.flatMap((runtimeMode) => [
    { ...LAUNCH, runtimeMode },
    { ...LAUNCH, runtimeMode, modelSelection: { instanceId: 'codex', model: 'synthetic-model' } },
    // A host with a workspace probe launches a project's own folder with the root strategy, or a worktree from the fresh remote base.
    { ...LAUNCH, runtimeMode, workspaceStrategy: { type: 'root' } },
    { ...LAUNCH, runtimeMode, workspaceStrategy: { ...LAUNCH.workspaceStrategy, startFromOrigin: true } },
    // A scratch alias (`workspaceMode: "scratch"`) launches with `scratch: true` alone: no project, worktree or branch is sent.
    { title: LAUNCH.title, message: LAUNCH.message, runtimeMode, scratch: true },
  ]),
  t3_thread_read: ['messages', 'activity'].flatMap((view) => [
    { threadId: THREAD_ID, view },
    { threadId: THREAD_ID, view, afterPosition: 1, limit: 100, runLimit: 50, maxCharsPerItem: 50000 },
    { threadId: THREAD_ID, view, itemId: 'synthetic-item', textOffset: 1, limit: 1, maxCharsPerItem: 50000 },
  ]),
  t3_thread_list: [
    { projectId: PROJECT_ID, limit: 100 },
    { projectId: PROJECT_ID, titleContains: '[job:synthetic]', settled: false, limit: 100, cursor: 100 },
    { projectId: PROJECT_ID, settled: true, limit: 100 },
  ],
  t3_thread_search: [{ projectId: PROJECT_ID, query: 'synthetic', limit: 20 }],
  t3_thread_organize: [{ threadId: THREAD_ID, action: 'settle' }],
  t3_thread_send: [{ threadId: THREAD_ID, message: 'Synthetic sample; never sent.', mode: 'auto', clientRequestId: CLIENT_REQUEST_ID }],
  t3_thread_interrupt: [
    { threadId: THREAD_ID, clientRequestId: CLIENT_REQUEST_ID },
    { threadId: THREAD_ID, clientRequestId: CLIENT_REQUEST_ID, reason: 'Synthetic sample; never sent.' },
  ],
  t3_pending_request: [
    { action: 'list', threadId: THREAD_ID },
    { action: 'read', threadId: THREAD_ID, requestId: REQUEST_ID },
    { action: 'respond', threadId: THREAD_ID, requestId: REQUEST_ID, answers: { synthetic_question: { answers: ['blue'] } } },
  ],
  t3_pending_request_list: [{ threadId: THREAD_ID }],
  t3_pending_request_read: [{ threadId: THREAD_ID, requestId: REQUEST_ID }],
  t3_pending_request_respond: [{ threadId: THREAD_ID, requestId: REQUEST_ID, answers: { synthetic_question: { answers: ['blue'] } } }],
};

/** Formats supported by the SDK's CfWorker validator; other formats must remain unverified. */
const FORMATS = new Set([
  'date', 'time', 'date-time', 'duration', 'uri', 'uri-reference', 'uri-template',
  'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer', 'json-pointer-uri-fragment',
  'relative-json-pointer',
]);

// Unknown keywords would otherwise be silently ignored and could falsely
// pass a request constrained by a future vocabulary. Preserve them in snapshots and report unverified.
const KEYWORDS = new Set([
  ...ANNOTATIONS, ...SCHEMA_MAPS, ...SCHEMA_VALUES, ...SCHEMA_ARRAYS,
  '$schema', '$id', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor',
  'type', 'const', 'enum', 'required', 'properties', 'dependencies', 'dependentRequired', 'items',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format', 'minProperties', 'maxProperties',
  'minItems', 'maxItems', 'uniqueItems', 'minContains', 'maxContains',
  'default', 'deprecated', 'readOnly', 'writeOnly', 'contentEncoding', 'contentMediaType',
]);

function hasUnsupportedSchema(schema: unknown): boolean {
  const nodes = schemaNodes(schema);
  if (hasUnsupportedReferences(nodes)) return true;
  return [...nodes.values()].some((node) => isObject(node) && (
    Object.keys(node).some((key) => !KEYWORDS.has(key))
    || (node.format !== undefined && (typeof node.format !== 'string' || !FORMATS.has(node.format)))
  ));
}

export function checkInputs(tools: readonly AdvertisedTool[]): InputCheck[] {
  const indexed = indexTools(tools);
  return requiredTools(indexed).map((name): InputCheck => {
    const tool = indexed.get(name);
    if (!tool) return { tool: name, status: 'fail', code: 'required_tool_missing' };
    try {
      if (hasUnsupportedSchema(tool.inputSchema)) return { tool: name, status: 'warn', code: 'input_schema_unsupported' };
      // This SDK validator has no generated-code or console logging paths. Clone because its
      // reference resolver annotates schemas; each tool also gets an independent reference table.
      const validate = new CfWorkerJsonSchemaValidator().getValidator(structuredClone(tool.inputSchema));
      const accepted = INPUT_SAMPLES[name].every((input) => validate(input).valid);
      return { tool: name, status: accepted ? 'pass' : 'fail', code: accepted ? 'sample_inputs_accepted' : 'sample_input_rejected' };
    } catch {
      // Compiler errors can embed schema values. Expose a fixed code, never that error text.
      return { tool: name, status: 'warn', code: 'input_schema_unsupported' };
    }
  });
}
