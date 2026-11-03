import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { pkceChallenge, randomToken } from '../../src/crypto.ts';
import { readBody } from '../../src/http/io.ts';
import { sendWebResponse, toWebRequest } from '../../src/http/web.ts';

export interface FakeT3Options {
  serverVersion?: string;
  launchRetryKeys?: boolean;
  modelSearch?: boolean;
  pendingRequestTools?: 'legacy' | 'combined' | 'both';
  /** Lifetime of issued credentials, seconds. T3 uses 30 days. */
  tokenLifetimeSeconds?: number;
  projectCount?: number;
}

export interface FakeQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value?: string | null }[];
  multiSelect?: boolean | null;
  allowCustomAnswer?: boolean | null;
  required?: boolean | null;
}

export interface FakeRun {
  runId: string;
  ordinal: number;
  status: string;
  providerInstanceId: string;
  model: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FakeItem {
  position: number;
  itemId: string;
  runId: string | null;
  messageId: string | null;
  /** null on items T3 itself adds, such as `subagent` and `notification`. */
  createdBy: 'user' | 'agent' | 'system' | null;
  creationSource: 'mcp' | 'provider' | 'web' | null;
  type: string;
  status: string;
  text: string;
  updatedAt: string;
  /** A `subagent` item's title: the delegated task's. */
  title?: string | null;
}

/** A model option as T3 advertises it in orchestrator_capabilities (a `select` with choices, or a `boolean`). */
export interface FakeOption {
  id: string;
  label?: string;
  values?: (string | boolean)[];
  default?: string | boolean;
  description?: string;
  type?: 'select' | 'boolean' | string;
  options?: { id: string; label: string; description?: string; isDefault?: boolean }[];
  currentValue?: string | boolean;
}

export interface FakeProvider {
  providerInstanceId: string;
  driverKind: string;
  displayName: string | null;
  models: { id: string; label: string | null; options?: FakeOption[] }[];
  runtimeModes?: string[];
  canRunChildTask: boolean;
  canRunCrossProviderChildTask: boolean;
  constraints: string[];
}

/** The synthetic catalog a fake host advertises by default: one provider, two models, a select and a boolean option. */
export function syntheticProviders(): FakeProvider[] {
  return [
    {
      providerInstanceId: 'synthetic-provider',
      driverKind: 'synthetic',
      displayName: 'Synthetic Provider',
      models: [
        {
          id: 'synthetic-model',
          label: 'Synthetic model',
          options: [
            {
              id: 'synthetic-effort',
              label: 'Synthetic effort',
              description: 'How hard the synthetic model thinks',
              type: 'select',
              options: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium', isDefault: true },
                { id: 'high', label: 'High', description: 'Slow and thorough' },
              ],
              currentValue: 'medium',
            },
            { id: 'synthetic-fast', label: 'Synthetic fast mode', type: 'boolean', currentValue: false },
          ],
        },
        { id: 'synthetic-large', label: null },
      ],
      runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
      canRunChildTask: true,
      canRunCrossProviderChildTask: false,
      constraints: [],
    },
  ];
}

export interface FakeThread {
  threadId: string;
  projectId: string;
  title: string;
  link: string;
  status: string;
  runtimeMode: string;
  branch: string | null;
  runs: FakeRun[];
  items: FakeItem[];
  questions: Map<string, FakeQuestion[] | null>;
  approvalsPending: number;
  /** Current T3 lists both shelves when settled is omitted. */
  settled: boolean;
  archived?: boolean;
  sideChat?: boolean;
  relationshipToParent?: 'fork' | null;
  createdAt: string;
  updatedAt: string;
  launch: Record<string, unknown>;
  /** A scratch thread's own folder, which T3 creates for it; null for a thread in a project's root or worktree. */
  scratchFolder: string | null;
}

/** Made-up environment id, used in thread links the way T3 builds them. */
export const FAKE_ENVIRONMENT_ID = 'env-synthetic';

const RUN_STATUSES = ['preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'] as const;
const THREAD_STATUSES = ['idle', ...RUN_STATUSES] as const;
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
/** Item types t3_thread_read's messages view returns; the activity view returns every item. */
const MESSAGE_VIEW_TYPES = new Set(['user_message', 'assistant_message', 'proposed_plan']);
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const attachmentMetadata = z.strictObject({
  type: z.enum(['image', 'file']), id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.int().min(1),
});
const attachmentUploadInput = z.strictObject({ upload: attachmentMetadata.omit({ id: true }) });
const attachmentSendInput = z.strictObject({ threadId: z.string().optional(), message: z.string().max(120000).optional(),
  attachments: z.array(attachmentMetadata).min(1).max(8) });

/** Input schemas copied field-for-field from T3's tools, strict so a misspelled field fails the test. */
const launchInput = z.strictObject({
  projectId: nullable(z.string()),
  scratch: nullable(z.boolean()),
  title: z.string(),
  modelSelection: nullable(z.looseObject({ model: z.unknown() })),
  runtimeMode: nullable(z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])),
  interactionMode: nullable(z.enum(['default', 'plan'])),
  workspaceStrategy: nullable(
    z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('root'), branch: nullable(z.string()) }),
      z.strictObject({ type: z.literal('existing_worktree'), worktreePath: z.string(), branch: nullable(z.string()) }),
      z.strictObject({ type: z.literal('worktree'), baseRef: z.string(), branch: nullable(z.string()), startFromOrigin: nullable(z.boolean()) }),
    ]),
  ),
  message: nullable(z.string().max(120000)),
  attachments: nullable(z.array(attachmentMetadata).max(8)),
});
const readInput = z.strictObject({
  threadId: z.string(),
  itemId: nullable(z.string()),
  textOffset: nullable(z.int().min(0)),
  view: nullable(z.enum(['messages', 'activity'])),
  afterPosition: nullable(z.int().min(0)),
  limit: nullable(z.int().min(1).max(100)),
  runLimit: nullable(z.int().min(1).max(50)),
  maxCharsPerItem: nullable(z.int().min(1).max(50000)),
});
const listInput = z.strictObject({
  projectId: nullable(z.string()),
  statuses: nullable(z.array(z.enum(THREAD_STATUSES)).max(10)),
  titleContains: nullable(z.string()),
  settled: nullable(z.boolean()),
  snoozed: nullable(z.boolean()),
  includeSubagents: nullable(z.boolean()),
  cursor: nullable(z.int().min(0)),
  limit: nullable(z.int().min(1).max(100)),
});
const searchInput = z.strictObject({ query: z.string(), limit: z.int().min(1).max(50).optional(), projectId: nullable(z.string()) });
const sendInput = z.strictObject({
  threadId: z.string(),
  message: z.string(),
  mode: nullable(z.enum(['auto', 'queue', 'steer', 'restart'])),
  clientRequestId: nullable(z.string()),
});
const interruptInput = z.strictObject({
  threadId: z.string(),
  runId: nullable(z.string()),
  reason: nullable(z.string().max(2000)),
  clientRequestId: nullable(z.string()),
});
const pendingListInput = z.strictObject({ threadId: nullable(z.string()) });
const projectListInput = z.strictObject({ cursor: nullable(z.int().min(0)), limit: nullable(z.int().min(1).max(100)) });
/** Legacy orchestrator_capabilities takes no arguments; current sessions optionally accept search. */
const capabilitiesInput = z.strictObject({});
const pendingReadInput = z.strictObject({ threadId: nullable(z.string()), requestId: z.string() });
const pendingRespondInput = z.strictObject({ threadId: nullable(z.string()), requestId: z.string(), answers: z.record(z.string(), z.unknown()) });

class FakeFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  token: string;
}

/**
 * A stand-in for a T3 Code server: the pairing-code OAuth endpoints and a sessionful MCP endpoint
 * with the environment, project, thread and pending-request tools the gateway uses, backed by an
 * in-memory thread model that tests drive (finish a turn, ask a question, fail a run). Synthetic
 * data only. Supports failure injection: T3 tool failures, slow answers, lost responses, downtime.
 */
export class FakeT3 {
  readonly serverVersion: string;
  pendingRequestTools: 'legacy' | 'combined' | 'both';
  launchRetryKeys: boolean;
  modelSearch: boolean;
  readonly capabilitySearches: (string | undefined)[] = [];
  readonly #launchResults = new Map<string, Record<string, unknown>>();
  toolsListCalls = 0;
  /** Synthetic tools/list pages keyed by the incoming cursor (empty string for the first page). */
  readonly toolsListPages = new Map<string, Record<string, unknown>>();
  tokenLifetimeSeconds: number;
  /** `workspaceRoot` is the folder T3 reports for the project; the workspace probe reads it (src/jobs/workspace.ts). */
  readonly projects: { id: string; title: string; deletedAt: string | null; defaultModelSelection: Record<string, unknown> | null; workspaceRoot?: string; pinnedAt?: string | null; archivedAt?: string | null }[];
  /** The providers, models and options this host advertises in orchestrator_capabilities; tests change it between calls. */
  providers: FakeProvider[] = syntheticProviders();
  /** When set, t3_project_list answers every page with this same nextCursor (a catalog that never converges). */
  projectListStuckCursor: number | null = null;
  /** Tool name to a T3 failure returned instead of a result. */
  readonly failures = new Map<string, { code: string; message: string }>();
  /** Tool name to a T3 failure returned after the call has taken effect (for example a launch that created the thread). */
  readonly failuresAfterEffect = new Map<string, { code: string; message: string }>();
  readonly calls: string[] = [];
  /** Every t3_thread_read input, in order (view, positions and sizes), for tests of the read pattern. */
  readonly reads: z.output<typeof readInput>[] = [];
  readonly validTokens = new Set<string>();
  readonly issuedTokens: string[] = [];
  readonly registeredClientNames: string[] = [];
  readonly decisions: { access: string }[] = [];
  /** When set, the decision endpoint refuses every pairing code. */
  rejectDecisions = false;
  /** Synthetic protocol failures and redirect denials; tests generate any sensitive sentinel at runtime. */
  pairingError: { status: number; body: unknown } | undefined;
  pairingDenial: string | undefined;
  readonly persistentStatus = new Map<string, number>();
  /** Restrict transport negotiation when simulating an older T3 host. */
  protocolVersions: string[] | undefined;
  /** Delay before answering tool calls, milliseconds. */
  toolDelayMs = 0;
  /** Per-tool delay before answering, milliseconds; overrides toolDelayMs for that tool. */
  readonly toolDelays = new Map<string, number>();
  /** Tools whose next call runs but whose HTTP response is then dropped (connection destroyed). */
  readonly dropResponseOnce = new Set<string>();
  /** Tools whose next call is answered with this bare HTTP status instead of running. */
  readonly statusOnce = new Map<string, number>();
  /** Threads whose t3_thread_read answers in a shape that does not match T3's schema. */
  readonly brokenReads = new Set<string>();
  /** Synthetic older/malformed detail fields, applied before the MCP result is serialized. */
  readonly threadDetailOverrides = new Map<string, Record<string, unknown>>();
  /** Thread id to a T3 failure returned by t3_thread_read for that thread only. */
  readonly readFailures = new Map<string, { code: string; message: string }>();
  /**
   * Tools whose calls take effect but whose answer is held back until releaseHeld() or stop(). `initialize` holds a new
   * session's MCP initialization before it is handled (a client still connecting); `notifications/initialized`
   * holds the final initialization notification's HTTP acknowledgement.
   */
  readonly holdResponses = new Set<string>();
  /**
   * The project T3 files `scratch: true` threads under (its internal scratch project). Tests pin their scratch aliases to it;
   * set it to another id to model a pin that is not T3's scratch project.
   */
  scratchProjectId = 'project-1';
  /** When set, t3_thread_launch creates the thread but starts no run on it (thread `idle`, no runs). */
  launchWithoutRun = false;
  /** A synthetic T3-minted id for the next launch. */
  nextThreadId: string | undefined;
  /** Model both older responses without links and the v1/v2 forms supplied by T3. */
  threadLinkFormat: 'omitted' | 'v1' | 'v2' | 'bare-v2' = 'omitted';
  /** When set, interrupts are accepted but take effect only on completeInterrupts(). */
  deferInterrupts = false;
  /** When set, an interrupt leaves the thread's pending questions listed (T3 may keep them). */
  keepQuestionsOnInterrupt = false;
  readonly threads = new Map<string, FakeThread>();
  /** Synthetic raw pages, including malformed entries and offset-page movement. */
  readonly threadListPages = new Map<number, Record<string, unknown>>();
  readonly sends: { threadId: string; message: string; clientRequestId: string | null }[] = [];
  readonly responses: { threadId: string; requestId: string; answers: Record<string, unknown> }[] = [];
  #sequence = 0;
  readonly #sendResults = new Map<string, Record<string, unknown>>();
  readonly #interruptResults = new Map<string, Record<string, unknown>>();
  readonly #deferredInterrupts = new Set<string>();
  /** Child thread id to the parent's thread and the position of its `subagent` item there. */
  readonly #delegations = new Map<string, { parentThreadId: string; position: number }>();
  readonly #held: { tool: string; release: () => void }[] = [];
  readonly #holdWaiters: { tool: string; resolve: () => void }[] = [];
  #server: Server | undefined;
  #port = 0;
  #offline = false;
  readonly #pairingCodes = new Set<string>();
  readonly #authCodes = new Map<string, { clientId: string; redirectUri: string; challenge: string; access: string }>();
  readonly #sessions = new Map<string, Session>();

  constructor(options: FakeT3Options = {}) {
    this.launchRetryKeys = options.launchRetryKeys ?? false;
    this.modelSearch = options.modelSearch ?? false;
    this.serverVersion = options.serverVersion ?? '0.0.0-test';
    this.pendingRequestTools = options.pendingRequestTools ?? 'legacy';
    this.tokenLifetimeSeconds = options.tokenLifetimeSeconds ?? 30 * 86400;
    this.projects = Array.from({ length: options.projectCount ?? 3 }, (_, i) => ({
      id: `project-${i + 1}`,
      title: `Synthetic project ${i + 1}`,
      deletedAt: null,
      defaultModelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model' },
    }));
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** argv for a mint command that asks this fake for a pairing code, like `t3 auth pairing create --json`. */
  mintCommand(): string[] {
    const script = `fetch(${JSON.stringify(`${this.url}/test/mint`)},{method:'POST'}).then(r=>r.text()).then(t=>process.stdout.write(t))`;
    return [process.execPath, '-e', script];
  }

  mintPairingCode(): string {
    const code = randomToken(12);
    this.#pairingCodes.add(code);
    return code;
  }

  revokeAllTokens(): void {
    this.validTokens.clear();
  }

  /** Every launch input, in order. */
  get launches(): Record<string, unknown>[] {
    return [...this.threads.values()].map((thread) => thread.launch);
  }

  /** The thread whose title ends with `[job:<jobId>]`. */
  threadForJob(jobId: string): FakeThread {
    const thread = [...this.threads.values()].find((candidate) => candidate.title.endsWith(`[job:${jobId}]`));
    if (!thread) throw new Error(`no thread for job ${jobId}`);
    return thread;
  }

  /** The worker finishes its turn with a final assistant message. */
  finishTurn(threadId: string, text: string): void {
    const thread = this.#thread(threadId);
    this.#addItem(thread, { runId: this.#activeRun(thread)?.runId ?? null, createdBy: 'agent', creationSource: 'provider', type: 'assistant_message', text });
    this.endTurn(threadId);
  }

  /** The active run completes without a further message. */
  endTurn(threadId: string): void {
    const thread = this.#thread(threadId);
    const run = this.#activeRun(thread);
    if (run) this.#endRun(run, 'completed');
    thread.status = 'completed';
    this.#touch(thread);
  }

  /** A person types into the thread in T3, starting a new turn. */
  userTurn(threadId: string, text: string): void {
    const thread = this.#thread(threadId);
    thread.settled = false;
    const run = this.#startRun(thread);
    this.#addItem(thread, { runId: run.runId, createdBy: 'user', creationSource: 'web', type: 'user_message', text });
  }

  /** The worker streams part of a message: an assistant item that is still running. */
  streamAssistant(threadId: string, text: string): FakeItem {
    const thread = this.#thread(threadId);
    const item = this.#addItem(thread, {
      runId: this.#activeRun(thread)?.runId ?? null,
      createdBy: 'agent',
      creationSource: 'provider',
      type: 'assistant_message',
      text,
      status: 'running',
    });
    return item;
  }

  /** The worker asks the user a question. Returns the pending request id. */
  askQuestion(threadId: string, questions: FakeQuestion[]): string {
    const thread = this.#thread(threadId);
    const requestId = `request-${++this.#sequence}`;
    thread.questions.set(requestId, questions);
    this.#setWaiting(thread);
    return requestId;
  }

  /** The worker needs a permission approval, which T3 does not expose through its MCP tools. */
  requestApproval(threadId: string): void {
    const thread = this.#thread(threadId);
    thread.approvalsPending += 1;
    this.#setWaiting(thread);
  }

  /** The operator approves in T3's UI. */
  grantApprovals(threadId: string): void {
    const thread = this.#thread(threadId);
    thread.approvalsPending = 0;
    this.#resume(thread);
  }

  failRun(threadId: string): void {
    const thread = this.#thread(threadId);
    const run = this.#activeRun(thread);
    if (run) this.#endRun(run, 'failed');
    thread.status = 'failed';
    this.#touch(thread);
  }

  /**
   * Activity the worker produces between messages (reasoning, tool calls, commands, checkpoints): items
   * only the activity view returns. Adds `count` items of `type`, created by the provider.
   */
  addActivity(threadId: string, type: string, count = 1, status = 'completed'): FakeItem[] {
    const thread = this.#thread(threadId);
    const runId = this.#activeRun(thread)?.runId ?? null;
    return Array.from({ length: count }, (_, index) =>
      this.#addItem(thread, { runId, createdBy: 'agent', creationSource: 'provider', type, status, text: `Synthetic ${type} ${index}` }),
    );
  }

  /**
   * The worker delegates a task to a child thread, as a T3 coordinator does (observed live): the parent's
   * timeline gets the delegate tool call and then one `subagent` item with no creator, titled with the
   * child's task, whose text is the child's task prompt while it works (its summary once done); the
   * child's own messages never appear in the parent. Both are activity items: the messages view does not
   * return them. `itemStatus` is the item's status while the child works. The parent's run then ends
   * with its own turn (finishTurn).
   */
  delegate(threadId: string, title: string, itemStatus = 'running'): { childThreadId: string; item: FakeItem } {
    const thread = this.#thread(threadId);
    const prompt = `Synthetic delegated task prompt: ${title}`;
    const { threadId: childThreadId } = this.launchDirect({ projectId: thread.projectId, title, message: prompt });
    const runId = this.#activeRun(thread)?.runId ?? null;
    this.#addItem(thread, { runId, createdBy: 'agent', creationSource: 'provider', type: 'dynamic_tool', text: 'Synthetic delegate call' });
    const item = this.#addItem(thread, { runId, createdBy: null, creationSource: null, type: 'subagent', status: itemStatus, text: prompt, title });
    this.#delegations.set(childThreadId, { parentThreadId: threadId, position: item.position });
    return { childThreadId, item };
  }

  /**
   * A delegated child finishes with `summary` (observed live): its `subagent` item in the parent completes
   * with the summary as text, T3 appends a `notification` item with no creator to the parent, and a new
   * run starts on the parent by itself.
   */
  finishDelegated(childThreadId: string, summary: string): void {
    const delegation = this.#delegations.get(childThreadId);
    if (!delegation) throw new Error(`no delegation for ${childThreadId}`);
    this.finishTurn(childThreadId, summary);
    const parent = this.#thread(delegation.parentThreadId);
    const item = parent.items[delegation.position];
    if (item) Object.assign(item, { status: 'completed', text: summary, updatedAt: new Date().toISOString() });
    this.#addItem(parent, { runId: null, createdBy: null, creationSource: null, type: 'notification', text: `Synthetic: subagent "${item?.title ?? ''}" finished` });
    this.#startRun(parent);
  }

  /**
   * A delegated child's `subagent` item in the parent settles as `status` (for example `failed`, or
   * `cancelled`) and T3 starts no run on the parent: the coordinator does not resume by itself.
   */
  settleDelegated(childThreadId: string, status: string): void {
    const delegation = this.#delegations.get(childThreadId);
    if (!delegation) throw new Error(`no delegation for ${childThreadId}`);
    const item = this.#thread(delegation.parentThreadId).items[delegation.position];
    if (item) Object.assign(item, { status, updatedAt: new Date().toISOString() });
  }

  /** Create a thread as t3_thread_launch would, outside MCP: a launch the gateway never heard back from. */
  launchDirect(input: Record<string, unknown>): { threadId: string } {
    return this.#launch(launchInput.parse(input)) as { threadId: string };
  }

  /** Finish streaming an item started with streamAssistant. */
  settleItem(threadId: string, position: number, text: string): void {
    const item = this.#thread(threadId).items[position];
    if (!item) throw new Error(`no item ${position}`);
    item.text = text;
    item.status = 'completed';
    item.updatedAt = new Date().toISOString();
  }

  /** Resolves once a call to `tool` has taken effect and its answer is being held (see holdResponses). */
  whenHeld(tool: string): Promise<void> {
    if (this.#held.some((held) => held.tool === tool)) return Promise.resolve();
    return new Promise((resolve) => this.#holdWaiters.push({ tool, resolve }));
  }

  /** Send every held answer, or only the `first` or `last` one to be held (callers in flight finish in the order the test chooses). */
  releaseHeld(which: 'all' | 'first' | 'last' = 'all'): void {
    const released = which === 'all' ? this.#held.splice(0) : this.#held.splice(which === 'first' ? 0 : this.#held.length - 1, 1);
    for (const held of released) held.release();
  }

  /** Apply interrupts accepted while deferInterrupts was set. */
  completeInterrupts(): void {
    for (const threadId of this.#deferredInterrupts) this.#interrupt(this.#thread(threadId));
    this.#deferredInterrupts.clear();
  }

  /**
   * Listen on a loopback port the first time; after stop(), come back on the same port. The port is
   * held until close(), so no other test process can take it while this host is "down".
   */
  async start(): Promise<this> {
    this.#offline = false;
    if (this.#server) return this;
    const server = createServer((req, res) => {
      // Reset once the request has arrived, not on accept: see the Invariants in AGENTS.md.
      if (this.#offline) return void req.socket.resetAndDestroy();
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.#port = (server.address() as AddressInfo).port;
    return this;
  }

  /**
   * Simulate the host going away: drop every connection and session, and reset new connections
   * as soon as a request arrives, until start() is called again. Nothing reaches the tools meanwhile.
   */
  async stop(): Promise<void> {
    this.#offline = true;
    this.releaseHeld();
    await this.forgetSessions();
    this.#server?.closeAllConnections();
  }

  /** Release the port for good. */
  async close(): Promise<void> {
    await this.stop();
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Drop every MCP session, as T3 does when it restarts, while keeping connections open. */
  async forgetSessions(): Promise<void> {
    for (const session of this.#sessions.values()) await session.transport.close();
    this.#sessions.clear();
  }

  readonly uploads = new Map<string, { metadata: z.infer<typeof attachmentMetadata>; bytes: Buffer | null }>();
  readonly attachmentSends: z.infer<typeof attachmentSendInput>[] = [];
  uploadRelativeUrl: string | undefined;
  uploadStatus = 200;

  #checkAttachments(items: z.infer<typeof attachmentMetadata>[]): void {
    for (const item of items) {
      const stored = this.uploads.get(item.id);
      if (!stored?.bytes || Object.entries(stored.metadata).some(([key, value]) => item[key as keyof typeof item] !== value)) throw new FakeFailure('invalid_request', 'Missing upload.');
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', this.url).pathname;
    if (path.startsWith('/api/attachments/upload/')) {
      const stored = this.uploads.get(path.split('/').at(-1)!);
      const bytes = await readBody(req, 6 * 1024 * 1024);
      if (!stored || stored.metadata.sizeBytes !== bytes.length) { res.writeHead(400).end(); return; }
      stored.bytes = bytes;
      res.writeHead(this.uploadStatus).end();
      return;
    }
    const body = req.method === 'POST' ? await readBody(req, 1024 * 1024) : undefined;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    };
    if (path === '/test/mint') return json(200, { credential: this.mintPairingCode(), expiresAt: new Date().toISOString() });
    if (path === '/oauth/mcp/register') {
      const input = JSON.parse(body?.toString() ?? '{}') as { client_name: string; redirect_uris: string[] };
      this.registeredClientNames.push(input.client_name);
      return json(201, {
        client_id: randomUUID(),
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }
    if (path === '/oauth/mcp/decision') {
      const input = JSON.parse(body?.toString() ?? '{}') as {
        authorization: { client_id: string; redirect_uri: string; code_challenge: string; state: string; resource: string };
        decision: { _tag: string; access: string; code: string };
      };
      if (this.pairingError) return json(this.pairingError.status, this.pairingError.body);
      if (this.pairingDenial) {
        const redirect = new URL(input.authorization.redirect_uri);
        redirect.searchParams.set('error', this.pairingDenial);
        return json(200, { redirectTo: redirect.href });
      }
      if (this.rejectDecisions || input.decision._tag !== 'pairing-code' || !this.#pairingCodes.delete(input.decision.code)) {
        return json(400, { _tag: 'AuthMcpApprovalError', message: 'The pairing code is invalid or expired.' });
      }
      if (input.authorization.resource !== `${this.url}/mcp`) return json(400, { message: 'wrong resource' });
      this.decisions.push({ access: input.decision.access });
      const code = randomToken();
      this.#authCodes.set(code, {
        clientId: input.authorization.client_id,
        redirectUri: input.authorization.redirect_uri,
        challenge: input.authorization.code_challenge,
        access: input.decision.access,
      });
      const redirect = new URL(input.authorization.redirect_uri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', input.authorization.state);
      return json(200, { redirectTo: redirect.href });
    }
    if (path === '/oauth/mcp/token') {
      const form = new URLSearchParams(body?.toString() ?? '');
      const grant = this.#authCodes.get(form.get('code') ?? '');
      this.#authCodes.delete(form.get('code') ?? '');
      if (
        !grant ||
        grant.clientId !== form.get('client_id') ||
        grant.redirectUri !== form.get('redirect_uri') ||
        grant.challenge !== pkceChallenge(form.get('code_verifier') ?? '')
      ) {
        return json(400, { error: 'invalid_grant' });
      }
      const token = randomToken();
      this.validTokens.add(token);
      this.issuedTokens.push(token);
      const scope = grant.access === 'read-only' ? 'orchestration:read' : 'orchestration:read orchestration:operate';
      return json(200, { access_token: token, expires_in: this.tokenLifetimeSeconds, scope, token_type: 'Bearer' });
    }
    if (path === '/mcp') return this.#handleMcp(req, res, body);
    json(404, { error: 'not_found' });
  }

  async #handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined): Promise<void> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !this.validTokens.has(token)) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${this.url}/.well-known/oauth-protected-resource"` }).end();
      return;
    }
    if (body) {
      const request = JSON.parse(body.toString());
      if (request.method === 'tools/list') {
        this.toolsListCalls++;
        const page = this.toolsListPages.get(request.params?.cursor ?? '');
        if (page) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: page }));
          return;
        }
      }
    }
    const injected = toolName(body);
    const status = injected === undefined ? undefined : this.statusOnce.get(injected) ?? this.persistentStatus.get(injected);
    if (injected !== undefined && status !== undefined) {
      this.statusOnce.delete(injected);
      res.writeHead(status).end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId === undefined && this.holdResponses.has('initialize') && isInitialize(body)) await this.#hold('initialize');
    if (this.holdResponses.has('notifications/initialized') && isInitialized(body)) await this.#hold('notifications/initialized');
    let transport: WebStandardStreamableHTTPServerTransport;
    if (typeof sessionId === 'string') {
      const session = this.#sessions.get(sessionId);
      if (!session || session.token !== token) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      transport = session.transport;
    } else {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        ...(this.protocolVersions ? { supportedProtocolVersions: this.protocolVersions } : {}),
        onsessioninitialized: (id) => {
          this.#sessions.set(id, { transport, token });
        },
      });
      await this.#buildServer(token).connect(transport);
    }
    const response = await transport.handleRequest(toWebRequest(req, body, this.url));
    const tool = toolName(body);
    if (tool && this.dropResponseOnce.delete(tool)) {
      // The tool ran; the caller never hears back.
      req.socket.destroy();
      return;
    }
    await sendWebResponse(res, response);
  }

  readonly pullRequests = new Map<string, Record<string, unknown>[]>();
  inlinePullRequests = false;

  #buildServer(namespace: string): McpServer {
    const server = new McpServer({ name: 'T3 Code', version: this.serverVersion });
    const run = async (tool: string, produce: () => Record<string, unknown>) => {
      this.calls.push(tool);
      const delay = this.toolDelays.get(tool) ?? this.toolDelayMs;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const failure = this.failures.get(tool);
      const fail = (value: { code: string; message: string }) => ({
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ _tag: 'OrchestratorMcpFailure', ...value }) }],
      });
      if (failure) return fail(failure);
      try {
        const value = produce();
        const after = this.failuresAfterEffect.get(tool);
        if (this.holdResponses.has(tool)) await this.#hold(tool);
        if (after) return fail(after);
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        if (error instanceof FakeFailure) return fail({ code: error.code, message: error.message });
        throw error;
      }
    };
    const tool = <S extends z.ZodObject>(name: string, input: S, produce: (args: z.output<S>) => Record<string, unknown>) =>
      server.registerTool(name, { inputSchema: input as z.ZodObject }, (args: unknown) => run(name, () => produce(args as z.output<S>)));
    server.registerTool('t3_environment_read', { inputSchema: z.object({}).loose() }, () =>
      run('t3_environment_read', () => ({
        environmentId: FAKE_ENVIRONMENT_ID,
        label: 'Synthetic host',
        serverVersion: this.serverVersion,
        platform: { os: 'linux', arch: 'x64' },
        preferences: { backgroundActivity: { profile: 'balanced' } },
      })),
    );
    tool('list_thread_pull_requests', z.strictObject({ threadId: z.string() }), ({ threadId }) => ({
      pullRequests: this.pullRequests.get(threadId) ?? [],
    }));
    tool('t3_project_list', projectListInput, ({ cursor, limit }) => {
      const start = cursor ?? 0;
      const size = limit ?? 50;
      const page = this.projects.slice(start, start + size);
      if (this.projectListStuckCursor !== null) return { projects: page, nextCursor: this.projectListStuckCursor };
      return { projects: page, nextCursor: start + size < this.projects.length ? start + size : null };
    });
    tool('orchestrator_capabilities', this.modelSearch ? capabilitiesInput.extend({ search: z.string().trim().min(1).max(200).optional() }) : capabilitiesInput, (input) => {
      const search = 'search' in input ? input.search as string | undefined : undefined;
      this.capabilitySearches.push(search);
      return {
        parentThreadId: null,
        inheritedProviderInstanceId: null,
        inheritedModel: null,
        runtimeMode: 'full-access',
        interactionMode: 'default',
        providers: !this.modelSearch ? this.providers : this.providers.map((provider) => {
          const terms = search?.toLowerCase().split(/\s+/).filter((term) =>
            !`${provider.providerInstanceId} ${provider.driverKind} ${provider.displayName ?? ''}`.toLowerCase().includes(term)) ?? [];
          const matches = provider.models.filter((model) => terms.every((term) => `${model.id} ${model.label ?? ''}`.toLowerCase().includes(term)));
          return { ...provider, models: matches.slice(0, 8), omittedModels: Math.max(0, matches.length - 8) };
        }),
        features: {
          appOwnedSubagents: true,
          asyncPolling: true,
          cancellation: true,
          batchThreadCreation: true,
          threadManagement: true,
          incrementalThreadRead: true,
          scheduledTasks: true,
          maxBatchThreads: 10,
        },
      };
    });
    tool('t3_attachment_prepare_upload', attachmentUploadInput, ({ upload }) => {
      const id = `pending-${randomUUID()}`;
      const metadata = { ...upload, id };
      this.uploads.set(id, { metadata, bytes: null });
      return { attachmentId: id, relativeUrl: this.uploadRelativeUrl ?? `/api/attachments/upload/${id}`, expiresAt: Date.now() + 600000 };
    });
    tool('t3_thread_send_attachments', attachmentSendInput, (input) => {
      this.#checkAttachments(input.attachments);
      this.attachmentSends.push(input);
      const sent = this.#send({ threadId: input.threadId!, message: input.message ?? '' });
      const { delivery, ...result } = sent;
      return result;
    });
    tool('t3_thread_launch', this.launchRetryKeys ? launchInput.extend({ clientRequestId: z.string().optional() }) : launchInput, (input) => {
      const requestId = 'clientRequestId' in input ? input.clientRequestId as string | undefined : undefined;
      const key = requestId ? `${namespace}:${requestId}` : undefined;
      const previous = key ? this.#launchResults.get(key) : undefined;
      if (previous) return previous;
      this.#checkAttachments(input.attachments ?? []);
      const result = this.#launch(input);
      if (key) this.#launchResults.set(key, result);
      return result;
    });
    tool('t3_thread_read', readInput, (input) => {
      this.reads.push(input);
      const failure = this.readFailures.get(input.threadId);
      if (failure) throw new FakeFailure(failure.code, failure.message);
      return this.brokenReads.has(input.threadId) ? { thread: { threadId: input.threadId } } : this.#read(input);
    });
    tool('t3_thread_list', listInput, (input) => {
      const overridden = this.threadListPages.get(input.cursor ?? 0);
      if (overridden) return overridden;
      const projectId = this.#target(input.projectId);
      const matching = [...this.threads.values()]
        .filter(
          (thread) =>
            thread.projectId === projectId && !thread.archived && !thread.sideChat &&
            (input.includeSubagents !== false || !this.#delegations.has(thread.threadId)) &&
            (input.settled == null || thread.settled === input.settled) &&
            (!input.titleContains || thread.title.includes(input.titleContains)),
        )
        .reverse();
      const start = input.cursor ?? 0;
      const size = input.limit ?? 50;
      return {
        projectId,
        currentThreadId: null,
        threads: matching.slice(start, start + size).map((thread) => this.#summary(thread)),
        nextCursor: start + size < matching.length ? start + size : null,
        total: matching.length,
      };
    });
    tool('t3_thread_search', searchInput, (input) => {
      const projectId = this.#target(input.projectId);
      const query = input.query.toLowerCase();
      const matches = [...this.threads.values()]
        .filter((thread) => thread.projectId === projectId)
        .flatMap((thread) => {
          const hit = [thread.title, ...thread.items.map((item) => item.text)].find((text) => text.toLowerCase().includes(query));
          return hit === undefined ? [] : [{ threadId: thread.threadId, projectId, source: 'user', snippet: hit.slice(0, 240), messageCreatedAt: null }];
        });
      return { matches: matches.slice(0, input.limit ?? 10) };
    });
    tool('t3_thread_organize', z.strictObject({ threadId: z.string(), action: z.literal('settle') }), ({ threadId }) => {
      const thread = this.#thread(threadId);
      if (this.#activeRun(thread)) throw new FakeFailure('orchestration_error', 'Thread is still running. Stop it before settling.');
      if (thread.runs.some((run) => run.status === 'queued')) {
        throw new FakeFailure('orchestration_error', 'Thread has a queued message. Send it or remove it from the queue before settling.');
      }
      if (thread.approvalsPending) {
        throw new FakeFailure('orchestration_error', 'Thread is waiting on an approval or question. Answer it before settling.');
      }
      thread.questions.clear();
      thread.settled = true;
      thread.updatedAt = new Date().toISOString();
      return { sequence: 1 };
    });
    tool('t3_thread_send', sendInput, (input) => this.#send(input, namespace));
    tool('t3_thread_interrupt', interruptInput, (input) => {
      const key = input.clientRequestId ? `${input.threadId}:${input.clientRequestId}` : undefined;
      const previous = key ? this.#interruptResults.get(key) : undefined;
      if (previous) return previous;
      const thread = this.#thread(input.threadId);
      const run = this.#activeRun(thread);
      let result: Record<string, unknown>;
      if (!run) {
        result = { threadId: thread.threadId, runId: null, status: 'no_active_run' };
      } else {
        if (this.deferInterrupts) this.#deferredInterrupts.add(thread.threadId);
        else this.#interrupt(thread);
        result = { threadId: thread.threadId, runId: run.runId, status: 'interrupt_requested' };
      }
      if (key) this.#interruptResults.set(key, result);
      return result;
    });
    const listPending = (input: z.output<typeof pendingListInput>) => ({
      requestIds: [...this.#thread(this.#target(input.threadId, 'threadId')).questions.keys()],
    });
    const readPending = (input: z.output<typeof pendingReadInput>) => {
      const questions = this.#thread(this.#target(input.threadId, 'threadId')).questions.get(input.requestId);
      if (questions === undefined) throw new FakeFailure('not_found', 'No such pending request.');
      return { requestId: input.requestId, questions };
    };
    const respondPending = (input: z.output<typeof pendingRespondInput>) => {
      const thread = this.#thread(this.#target(input.threadId, 'threadId'));
      if (!thread.questions.delete(input.requestId)) throw new FakeFailure('not_found', 'No such pending request.');
      this.responses.push({ threadId: thread.threadId, requestId: input.requestId, answers: input.answers });
      if (thread.questions.size === 0 && thread.approvalsPending === 0) this.#resume(thread);
      return { sequence: ++this.#sequence };
    };
    if (this.pendingRequestTools !== 'combined') {
      tool('t3_pending_request_list', pendingListInput, listPending);
      tool('t3_pending_request_read', pendingReadInput, readPending);
      tool('t3_pending_request_respond', pendingRespondInput, respondPending);
    }
    if (this.pendingRequestTools !== 'legacy') {
      tool('t3_pending_request', z.strictObject({
        action: z.enum(['list', 'read', 'respond']), threadId: nullable(z.string()),
        requestId: nullable(z.string()), answers: nullable(z.record(z.string(), z.unknown())),
      }), (input) => {
        switch (input.action) {
          case 'list': return listPending(pendingListInput.parse({ threadId: input.threadId }));
          case 'read': return readPending(pendingReadInput.parse({ threadId: input.threadId, requestId: input.requestId }));
          case 'respond': return respondPending(pendingRespondInput.parse({
            threadId: input.threadId, requestId: input.requestId, answers: input.answers,
          }));
        }
      });
    }
    return server;
  }

  #target(value: string | null | undefined, field = 'projectId'): string {
    if (!value) throw new FakeFailure('target_required', `Pass ${field}: this MCP client is not running inside a T3 thread.`);
    return value;
  }

  #thread(threadId: string): FakeThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new FakeFailure('thread_not_found', 'No such thread.');
    return thread;
  }

  #activeRun(thread: FakeThread): FakeRun | undefined {
    return thread.runs.findLast((run) => ACTIVE.has(run.status));
  }

  #hold(tool: string): Promise<void> {
    const held = new Promise<void>((release) => this.#held.push({ tool, release }));
    for (const waiter of this.#holdWaiters.filter((candidate) => candidate.tool === tool)) {
      this.#holdWaiters.splice(this.#holdWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    return held;
  }

  #touch(thread: FakeThread): void {
    thread.updatedAt = new Date().toISOString();
  }

  #addItem(thread: FakeThread, item: Omit<FakeItem, 'position' | 'itemId' | 'messageId' | 'status' | 'updatedAt'> & { status?: string }): FakeItem {
    const position = thread.items.length;
    const created: FakeItem = {
      position,
      itemId: `${thread.threadId}-item-${position}`,
      messageId: `${thread.threadId}-message-${position}`,
      status: 'completed',
      updatedAt: new Date().toISOString(),
      ...item,
    };
    thread.items.push(created);
    this.#touch(thread);
    return created;
  }

  #startRun(thread: FakeThread): FakeRun {
    const now = new Date().toISOString();
    const run: FakeRun = {
      runId: `${thread.threadId}-run-${thread.runs.length + 1}`,
      ordinal: thread.runs.length + 1,
      status: 'running',
      providerInstanceId: 'synthetic-provider',
      model: 'synthetic-model',
      requestedAt: now,
      startedAt: now,
      completedAt: null,
    };
    thread.runs.push(run);
    thread.status = 'running';
    this.#touch(thread);
    return run;
  }

  #endRun(run: FakeRun, status: string): void {
    run.status = status;
    run.completedAt = new Date().toISOString();
  }

  #setWaiting(thread: FakeThread): void {
    const run = this.#activeRun(thread);
    if (run) run.status = 'waiting';
    thread.status = 'waiting';
    this.#touch(thread);
  }

  #resume(thread: FakeThread): void {
    const run = this.#activeRun(thread);
    if (run) run.status = 'running';
    thread.status = 'running';
    this.#touch(thread);
  }

  #interrupt(thread: FakeThread): void {
    const run = this.#activeRun(thread);
    if (run) this.#endRun(run, 'interrupted');
    if (!this.keepQuestionsOnInterrupt) thread.questions.clear();
    thread.approvalsPending = 0;
    thread.status = 'interrupted';
    this.#touch(thread);
  }

  #launch(input: z.output<typeof launchInput>): Record<string, unknown> {
    // As T3 does: `scratch` is exclusive with a project and a workspace strategy, and T3 files the thread under its scratch project.
    if (input.scratch) {
      if (input.projectId || input.workspaceStrategy) {
        throw new FakeFailure('invalid_request', 'scratch cannot be combined with projectId or workspaceStrategy.');
      }
    }
    const projectId = input.scratch ? this.scratchProjectId : this.#target(input.projectId);
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new FakeFailure('project_not_found', 'No such project.');
    if (!input.modelSelection && !project.defaultModelSelection) {
      throw new FakeFailure('invalid_request', 'Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.');
    }
    const threadId = this.nextThreadId ?? `thread-${this.threads.size + 1}`;
    this.nextThreadId = undefined;
    const now = new Date().toISOString();
    const strategy = input.workspaceStrategy;
    const thread: FakeThread = {
      threadId,
      projectId,
      title: input.title,
      link: this.threadLinkFormat === 'v1' ? `[${input.title}](t3-thread://v1/${threadId})`
        : this.threadLinkFormat === 'bare-v2' ? `t3-thread://v2/${FAKE_ENVIRONMENT_ID}/${threadId}`
        : `<t3-thread://v2/${FAKE_ENVIRONMENT_ID}/${threadId}>`,
      status: 'idle',
      runtimeMode: input.runtimeMode ?? 'full-access',
      branch: strategy && 'branch' in strategy ? (strategy.branch ?? null) : null,
      runs: [],
      items: [],
      questions: new Map(),
      approvalsPending: 0,
      settled: false,
      createdAt: now,
      updatedAt: now,
      launch: input,
      scratchFolder: input.scratch ? `/synthetic/scratch/${threadId}` : null,
    };
    this.threads.set(threadId, thread);
    let run: FakeRun | undefined;
    if (input.message && !this.launchWithoutRun) {
      run = this.#startRun(thread);
      this.#addItem(thread, { runId: run.runId, createdBy: 'agent', creationSource: 'mcp', type: 'user_message', text: input.message });
    }
    return {
      threadId,
      ...(this.threadLinkFormat !== 'omitted' ? { link: thread.link } : {}),
      projectId,
      modelSelection: input.modelSelection ?? { model: 'synthetic-model' },
      runId: run?.runId ?? null,
      status: run?.status ?? null,
    };
  }

  #send(input: z.output<typeof sendInput>, namespace = ''): Record<string, unknown> {
    const key = input.clientRequestId ? `${namespace}:${input.threadId}:${input.clientRequestId}` : undefined;
    const previous = key ? this.#sendResults.get(key) : undefined;
    if (previous) return previous;
    const thread = this.#thread(input.threadId);
    thread.settled = false;
    this.sends.push({ threadId: thread.threadId, message: input.message, clientRequestId: input.clientRequestId ?? null });
    const active = this.#activeRun(thread);
    const run = active ?? this.#startRun(thread);
    this.#addItem(thread, { runId: run.runId, createdBy: 'agent', creationSource: 'mcp', type: 'user_message', text: input.message });
    const result = {
      threadId: thread.threadId,
      messageId: `${thread.threadId}-message-${thread.items.length - 1}`,
      runId: run.runId,
      status: run.status,
      delivery: active ? 'steered' : 'started',
    };
    if (key) this.#sendResults.set(key, result);
    return result;
  }

  #summary(thread: FakeThread): Record<string, unknown> {
    return {
      threadId: thread.threadId,
      ...(this.threadLinkFormat !== 'omitted' ? { link: thread.link } : {}),
      title: thread.title,
      createdBy: 'agent',
      creationSource: 'mcp',
      status: thread.status,
      latestRunId: thread.runs.at(-1)?.runId ?? null,
      providerInstanceId: 'synthetic-provider',
      model: 'synthetic-model',
      runtimeMode: thread.runtimeMode,
      interactionMode: 'default',
      linkedPullRequest: null,
      ...(this.inlinePullRequests ? { pullRequests: this.pullRequests.get(thread.threadId) ?? [] } : {}),
      settled: thread.settled,
      settledAt: thread.settled ? thread.updatedAt : null,
      snoozed: false,
      snoozedUntil: null,
      parentThreadId: this.#delegations.get(thread.threadId)?.parentThreadId ?? null,
      relationshipToParent: this.#delegations.has(thread.threadId) ? 'subagent' : thread.relationshipToParent ?? null,
      itemCount: thread.items.length,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  /**
   * T3's two views over the same positions: `messages` (the default) returns only user messages,
   * assistant messages and proposed plans, skipping everything else; `activity` returns every item.
   * `nextPosition` is the last returned item's position either way. With `itemId`, as a live T3 does,
   * the page is that one item (none when the thread has no such item), its text from `textOffset`.
   */
  #read(input: z.output<typeof readInput>): Record<string, unknown> {
    const thread = this.#thread(input.threadId);
    const after = input.afterPosition ?? -1;
    const limit = input.limit ?? 50;
    const inView = (input.view ?? 'messages') === 'activity' ? () => true : (item: FakeItem) => MESSAGE_VIEW_TYPES.has(item.type);
    const remaining = thread.items.filter((item) =>
      input.itemId != null ? item.itemId === input.itemId && inView(item) : item.position > after && inView(item),
    );
    const page = remaining.slice(0, limit);
    const maxChars = input.maxCharsPerItem ?? 4000;
    const offset = input.itemId != null ? (input.textOffset ?? 0) : 0;
    const active = this.#activeRun(thread);
    return {
      thread: {
        ...this.#summary(thread),
        projectId: thread.projectId,
        activeRunId: active?.runId ?? null,
        titleRegeneration: null,
        branch: thread.branch,
        worktreePath: null,
        runCount: thread.runs.length,
        pendingRequestCount: thread.questions.size + thread.approvalsPending,
        archived: thread.archived ?? false,
        ...this.threadDetailOverrides.get(thread.threadId),
      },
      recentRuns: thread.runs.slice(-(input.runLimit ?? 10)).reverse(),
      items: page.map((item) => ({
        ...item,
        visibility: 'local',
        sourceThreadId: thread.threadId,
        title: item.title ?? null,
        text: item.text.slice(offset, offset + maxChars),
        textTruncated: item.text.length > offset + maxChars,
        nextTextOffset: item.text.length > offset + maxChars ? offset + maxChars : null,
      })),
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: remaining.length > page.length,
    };
  }
}

function isInitialize(body: Buffer | undefined): boolean {
  try {
    return (JSON.parse(body?.toString() ?? '') as { method?: unknown }).method === 'initialize';
  } catch {
    return false;
  }
}

function toolName(body: Buffer | undefined): string | undefined {
  try {
    const message = JSON.parse(body?.toString() ?? '') as { method?: unknown; params?: { name?: unknown } };
    return message.method === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name : undefined;
  } catch {
    return undefined;
  }
}

export async function startFakeT3(options: FakeT3Options = {}): Promise<FakeT3> {
  return new FakeT3(options).start();
}

function isInitialized(body: Buffer | undefined): boolean {
  try {
    return (JSON.parse(body?.toString() ?? '') as { method?: unknown }).method === 'notifications/initialized';
  } catch {
    return false;
  }
}
