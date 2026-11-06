import type { AttachmentInput } from '../jobs/attachments.ts';
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import * as z from 'zod';
import { pullRequestListSchema } from '../jobs/pullRequests.ts';
import { GatewayError, type ErrorCode } from '../errors.ts';
import { sha256Hex } from '../crypto.ts';
import { isTypeOfServiceRace } from '../processErrors.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import { parseToolResult, T3ToolError } from './results.ts';
import {
  attachmentUploadSchema,
  attachmentSendSchema,
  type T3Attachment,
  capabilitiesSchema,
  environmentSchema,
  interruptResultSchema,
  launchResultSchema,
  pendingRequestListSchema,
  pendingRequestSchema,
  projectListSchema,
  respondResultSchema,
  sendResultSchema,
  threadListSchema,
  threadReadSchema,
  threadSearchSchema,
  type InterruptResult,
  type LaunchResult,
  type LaunchThreadInput,
  type PendingRequest,
  type SendResult,
  type T3Capabilities,
  type T3Environment,
  type T3Project,
  threadCatalogPageSchema,
  type ThreadList,
  type ThreadRead,
  type ThreadSearch,
} from './schemas.ts';

export const DEFAULT_T3_TIMEOUT_MS = 15_000;
/** Projects are read in pages of 100; a host with more than 20 pages is not enumerated at all (`catalog_limit`). */
export const MAX_PROJECT_PAGES = 20;
export const PROJECT_PAGE_SIZE = 100;

export interface T3ClientOptions {
  hostId: string;
  t3Url: string;
  /** Current bearer credential for this host, read before every request so renewals apply at once. */
  token: () => string | undefined;
  timeoutMs?: number;
  /** Lifetime cancellation for a dedicated client (background reachability probes only). */
  signal?: AbortSignal;
  /** Every logical host call, including catalogs and optional tools; no input or response content. */
  contact?: (error?: unknown, serverVersion?: string) => void;
  /** Completed logical calls only, after retries; no input or response content. */
  observe?: (name: string, error?: unknown) => void;
  /** Dedicated enrollment probes only: numeric MCP POST status, before the SDK can discard it during authorization. */
  observeHttpStatus?: (status: number) => void;
}

export interface CallOptions {
  /** Probes make one attempt, including when the host has forgotten a session. */
  retry?: false;
  timeoutMs?: number;
  /** The tool does not change T3 state, so a call lost in transit may be repeated. */
  readOnly?: boolean;
  /** Durable send guard, called with a private digest of the exact connection credential before delivery. Never log it. */
  beforeSend?: (identity: string) => void;
}

function httpStatus(error: unknown): number | undefined {
  return error instanceof SdkHttpError ? error.status : undefined;
}

/**
 * Whether T3 may have received a call that failed in transport. `not_delivered`: the request never
 * reached T3's tool handler (no connection, refused, rejected before handling), so nothing happened.
 * `unknown`: it may have run (timeout after sending, connection reset, 5xx), so a state-changing
 * call has an unknown outcome.
 */
export type Delivery = 'not_delivered' | 'unknown';

/** A transport-level failure talking to T3, with what is known about delivery. */
export class T3TransportError extends GatewayError {
  readonly delivery: Delivery;

  constructor(code: ErrorCode, message: string, delivery: Delivery, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = 'T3TransportError';
    this.delivery = delivery;
  }
}

/** Socket errors that mean the request was never sent: nothing accepted the connection. */
const CONNECT_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT']);

function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECT_FAILURES.has(code)) return code;
    // Thrown before the request was written to a connection the peer had already reset.
    if (isTypeOfServiceRace(current)) return 'EINVAL';
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether a failed call means the MCP session itself is unusable, so the connection must be
 * replaced. A request timeout or a 5xx answer is a failure of that one request: the session stays,
 * and so do the other calls in flight on it.
 */
function sessionFailed(error: unknown, connected: boolean): boolean {
  if (!connected) return true;
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return false;
  const status = httpStatus(error);
  return status === undefined || status < 500;
}

const PENDING_ACTIONS: Readonly<Record<string, 'list' | 'read' | 'respond'>> = {
  t3_pending_request_list: 'list', t3_pending_request_read: 'read', t3_pending_request_respond: 'respond',
};
const toolsPageSchema = z.object({
  tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown().optional() })).max(1024), nextCursor: z.string().optional(),
});

interface Connection {
  client: Promise<Client>;
  instance: Client;
  cancel: () => void;
  token: string;
  /** Increases with every new connection, so a late failure on an old one cannot close a newer one. */
  generation: number;
  tools?: Promise<Map<string, unknown>>;
}

/**
 * MCP client for one T3 Code server. Connects lazily, keeps the session, and reconnects after
 * session-level failures (connection errors, a forgotten session, a rejected credential) or a
 * credential change. Failures surface as GatewayError with stable codes.
 */
export class T3Client {
  readonly hostId: string;
  readonly #url: URL;
  readonly #token: () => string | undefined;
  readonly #timeoutMs: number;
  #connection: Connection | undefined;
  #generation = 0;
  readonly #observe: T3ClientOptions['observe'];
  readonly #contact: T3ClientOptions['contact'];
  readonly #signal: AbortSignal | undefined;
  readonly #observeHttpStatus: T3ClientOptions['observeHttpStatus'];

  constructor(options: T3ClientOptions) {
    this.#observe = options.observe;
    this.#observeHttpStatus = options.observeHttpStatus;
    this.#contact = options.contact;
    this.#signal = options.signal;
    this.hostId = options.hostId;
    this.#url = new URL('/mcp', options.t3Url);
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_T3_TIMEOUT_MS;
  }

  /**
   * Call a T3 tool. A 404 (T3 forgot the session, so it never handled the call) is retried once on
   * a new session. Other transport failures are retried once for reads or advertised keyed launches:
   * all other state changes keep an ambiguous lost response for their caller to resolve.
   * Transport failures are thrown as T3TransportError, whose `delivery` tells the two cases apart.
   * Only session-level failures replace the connection; a timeout leaves other calls on it running.
   */
  async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, options: CallOptions = {}): Promise<T> {
    // CatalogService observes complete catalog validation; optional PR reads are not host-health requirements.
    const observe = name === 'list_thread_pull_requests' || name === 'orchestrator_capabilities' ? undefined : this.#observe;
    try {
      const value = await this.#callTool(name, args, schema, options);
      this.#contact?.(undefined, name === 't3_environment_read' ? (value as T3Environment).serverVersion : undefined);
      observe?.(name);
      return value;
    } catch (error) {
      // Shutdown cancellation is not evidence that the host failed.
      if (!this.#signal?.aborted || this.#signal.reason instanceof GatewayError) {
        this.#contact?.(error);
        observe?.(name, error);
      }
      throw error;
    }
  }

  async #callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, options: CallOptions): Promise<T> {
    const timeout = options.timeoutMs ?? this.#timeoutMs;
    let retryingKeyedLaunch = false;
    let launchCredential: string | undefined;
    let priorOutcomeUnknown = false;
    for (let attempt = 0; ; attempt++) {
      let sent = false;
      let connected = false;
      let connection: Connection | undefined;
      let keyedLaunch = false;
      try {
        this.#signal?.throwIfAborted();
        connection = this.#connect(timeout);
        const client = await connection.client;
        if (retryingKeyedLaunch && connection.token !== launchCredential) {
          throw new T3TransportError('t3_response_lost', 'T3 authorization changed during launch retry; reconcile the original launch.', 'unknown');
        }
        connected = true;
        // Resolve before sending, on this exact session (including a reconnect after HTTP 404).
        // A failed response never switches tool names: answers have no downstream retry key.
        const action = PENDING_ACTIONS[name];
        const discover = action !== undefined || name === 't3_thread_launch' || name === 'orchestrator_capabilities';
        const tools = discover ? await this.#tools(connection, client, timeout) : undefined;
        let combined = false;
        if (action !== undefined) {
          try { combined = this.#usesCombinedPendingRequests(tools!); }
          catch (error) { connection.tools = undefined; throw error; }
        }
        const toolName = combined ? 't3_pending_request' : name;
        const input: Record<string, unknown> = combined ? { ...args, action } : { ...args };
        if (name === 't3_thread_launch') {
          keyedLaunch = typeof args.clientRequestId === 'string' && this.#hasInput(tools!, name, 'clientRequestId');
          // Never downgrade a retry of a possibly accepted keyed launch into an unkeyed launch.
          if (retryingKeyedLaunch && !keyedLaunch) {
            throw new T3TransportError('t3_response_lost', 'T3 no longer advertises launch retry keys; reconcile the original launch.', 'unknown');
          }
          if (!keyedLaunch) delete input.clientRequestId;
          if (keyedLaunch && !retryingKeyedLaunch) launchCredential = connection.token;
        }
        if (name === 'orchestrator_capabilities' && !this.#hasInput(tools!, name, 'search')) delete input.search;
        options.beforeSend?.(sha256Hex(JSON.stringify([this.hostId, connection.token])));
        sent = true;
        const result = await client.callTool({ name: toolName, arguments: input }, { timeout, signal: this.#signal });
        return parseToolResult(toolName, result, schema);
      } catch (error) {
        if (this.#signal?.aborted) throw this.#signal.reason;
        if (priorOutcomeUnknown && error instanceof T3ToolError) {
          throw new T3TransportError('t3_response_lost', 'T3 refused a launch retry after an uncertain first attempt; reconcile the original launch.', 'unknown');
        }
        if (error instanceof GatewayError) {
          if (priorOutcomeUnknown && error instanceof T3TransportError && error.delivery === 'not_delivered') {
            throw new T3TransportError(error.code, error.message, 'unknown');
          }
          throw error;
        }
        if (connection && sessionFailed(error, connected)) await this.#reset(connection.generation);
        let translated = this.#translate(error, sent);
        if (priorOutcomeUnknown && translated.delivery === 'not_delivered') {
          translated = new T3TransportError(translated.code, translated.message, 'unknown');
        }
        const retryable =
          httpStatus(error) === 404 || ((options.readOnly === true || keyedLaunch) &&
            (translated.code === 'host_unreachable' || translated.code === 't3_response_lost' || (keyedLaunch && translated.code === 't3_timeout')));
        if (options.retry !== false && retryable && attempt === 0) {
          retryingKeyedLaunch = keyedLaunch;
          priorOutcomeUnknown = keyedLaunch && translated.delivery === 'unknown';
          continue;
        }
        throw translated;
      }
    }
  }

  /** Bounded discovery shared by one session. Only names and optional input fields are inspected; never output schemas. */
  async #tools(connection: Connection, client: Client, timeout: number): Promise<Map<string, unknown>> {
    if (!connection.tools) {
      const discovery = (async () => {
        const tools = new Map<string, unknown>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 32; page++) {
          // request(), rather than listTools(), keeps advertised output schemas out of the SDK's validator cache.
          const result = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
            toolsPageSchema, { timeout, signal: this.#signal });
          for (const tool of result.tools) {
            if (tools.has(tool.name) || tools.size >= 4096) {
              throw new GatewayError('t3_invalid_response', 'T3 tool discovery returned duplicate tools or exceeded its bound.');
            }
            tools.set(tool.name, tool.inputSchema);
          }
          if (result.nextCursor === undefined) return tools;
          if (cursors.has(result.nextCursor)) break;
          cursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        throw new GatewayError('t3_invalid_response', 'T3 tool discovery did not finish within its bound.');
      })();
      connection.tools = discovery;
      void discovery.catch(() => {
        if (connection.tools === discovery) connection.tools = undefined;
      });
    }
    return connection.tools;
  }

  #hasInput(tools: Map<string, unknown>, name: string, field: string): boolean {
    const schema = tools.get(name);
    if (!schema || typeof schema !== 'object') return false;
    const properties = Reflect.get(schema, 'properties');
    return !!properties && typeof properties === 'object' && Object.hasOwn(properties, field);
  }

  #usesCombinedPendingRequests(tools: Map<string, unknown>): boolean {
    if (tools.has('t3_pending_request')) return true;
    if (Object.keys(PENDING_ACTIONS).every((name) => tools.has(name))) return false;
    throw new GatewayError('t3_invalid_response', 'T3 does not advertise a complete pending-request tool contract.');
  }

  /** Optional on older T3 builds. The watcher isolates all errors from this read. */
  listThreadPullRequests(threadId: string) {
    return this.callTool('list_thread_pull_requests', { threadId }, pullRequestListSchema, { readOnly: true, timeoutMs: 3000 });
  }

  environmentRead(options: Pick<CallOptions, 'timeoutMs' | 'retry'> = {}): Promise<T3Environment> {
    return this.callTool('t3_environment_read', {}, environmentSchema, { ...options, readOnly: true });
  }

  /**
   * Every T3 project on the host that is not deleted. Bounded: at most MAX_PROJECT_PAGES pages of
   * PROJECT_PAGE_SIZE, else `catalog_limit`; a cursor that repeats or does not advance is
   * `t3_invalid_response`. Nothing partial is ever returned.
   */
  async listProjects(): Promise<T3Project[]> {
    const projects: T3Project[] = [];
    const seen = new Set<number>();
    let cursor: number | null | undefined = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PROJECT_PAGES) {
        throw new GatewayError(
          'catalog_limit',
          `Host ${this.hostId} has more than ${MAX_PROJECT_PAGES * PROJECT_PAGE_SIZE} T3 projects; the gateway does not enumerate that many.`,
        );
      }
      const result: z.infer<typeof projectListSchema> = await this.callTool(
        't3_project_list',
        cursor === null ? { limit: PROJECT_PAGE_SIZE } : { limit: PROJECT_PAGE_SIZE, cursor },
        projectListSchema,
        { readOnly: true },
      );
      projects.push(...result.projects);
      const next = result.nextCursor;
      if (next === null || next === undefined) break;
      if (seen.has(next) || (cursor !== null && next <= cursor)) {
        throw new GatewayError('t3_invalid_response', `t3_project_list on host ${this.hostId} returned a cursor that does not advance.`);
      }
      seen.add(next);
      cursor = next;
    }
    return projects.filter((project) => !project.deletedAt);
  }

  /** The providers, models and model options T3 advertises on this host. Read-only; retried like any read. */
  readCapabilities(options: { timeoutMs?: number; search?: string } = {}): Promise<T3Capabilities> {
    return this.callTool('orchestrator_capabilities', options.search ? { search: options.search } : {}, capabilitiesSchema, { timeoutMs: options.timeoutMs, readOnly: true });
  }

  /** Retry once only when this session advertises clientRequestId. Legacy lost replies stay ambiguous. */
  launchThread(input: LaunchThreadInput, options: { timeoutMs?: number } = {}): Promise<LaunchResult> {
    return this.callTool('t3_thread_launch', { ...input }, launchResultSchema, options);
  }

  /** Stage on the destination host, never on the gateway's filesystem. Signed URLs are private and never logged. */
  async uploadAttachments(items: readonly AttachmentInput[]): Promise<T3Attachment[]> {
    const uploaded: T3Attachment[] = [];
    for (const item of items) {
      const bytes = Buffer.from(item.data, 'base64');
      const metadata = { type: item.mimeType.startsWith('image/') ? 'image' as const : 'file' as const,
        name: item.name!, mimeType: item.mimeType, sizeBytes: bytes.length };
      let prepared;
      try { prepared = await this.callTool('t3_attachment_prepare_upload', { upload: metadata }, attachmentUploadSchema); }
      catch (error) {
        if (error instanceof T3ToolError) throw new T3ToolError(error.tool, error.t3Code, 'T3 could not prepare the attachment upload.');
        throw error;
      }
      // T3 is trusted for the upload capability, but cannot redirect this gateway to another destination.
      let url: URL;
      try { url = new URL(prepared.relativeUrl, this.#url); }
      catch { throw new GatewayError('t3_invalid_response', 'T3 returned an invalid attachment upload route.'); }
      if (!prepared.relativeUrl.startsWith('/api/attachments/upload/') || url.origin !== this.#url.origin || !url.pathname.startsWith('/api/attachments/upload/') || url.username || url.password || url.hash) {
        throw new GatewayError('t3_invalid_response', 'T3 returned an invalid attachment upload route.');
      }
      let status: number;
      try {
        const response = await fetch(url, { method: 'POST', body: bytes, redirect: 'manual',
          headers: { 'content-type': item.mimeType }, signal: AbortSignal.timeout(this.#timeoutMs) });
        await response.body?.cancel();
        status = response.status;
      } catch {
        // Fetch errors can include signed URLs and arbitrary response data. Never expose the cause.
        throw new GatewayError('host_unreachable', 'T3 attachment upload failed. No thread message was sent; retry with the same requestId.');
      }
      if (status >= 300 && status < 400) throw new GatewayError('t3_invalid_response', 'T3 attachment upload redirects are not allowed.');
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new GatewayError('invalid_argument', 'T3 refused the attachment upload. Check the file type and size before starting new work.');
      }
      if (status < 200 || status >= 300) throw new GatewayError('host_unreachable', 'T3 attachment upload failed. No thread message was sent; retry with the same requestId.');
      uploaded.push({ ...metadata, id: prepared.attachmentId });
    }
    return uploaded;
  }

  /** No retry key in this T3 API. The caller must durably mark an attempt before calling it. */
  sendAttachments(threadId: string, message: string, attachments: T3Attachment[]) {
    return this.callTool('t3_thread_send_attachments', { threadId, message, attachments }, attachmentSendSchema, { retry: false });
  }

  /**
   * One page of a thread's state and timeline. `afterPosition` continues from a previous `nextPosition`.
   * Callers name the view: `messages` returns user and assistant messages and proposed plans only,
   * `activity` every timeline item (delegated work, reasoning, tools, checkpoints); positions are shared.
   * With `itemId`, T3 returns that one item (none if it has no such item), its text from `textOffset`.
   */
  readThread(input: {
    threadId: string;
    view: 'messages' | 'activity';
    afterPosition?: number | null;
    itemId?: string;
    textOffset?: number;
    limit?: number;
    runLimit?: number;
    maxCharsPerItem?: number;
  }): Promise<ThreadRead> {
    return this.callTool('t3_thread_read', withoutNulls(input), threadReadSchema, { readOnly: true });
  }

  /** Threads in a project, newest first; omitted settled includes both shelves on current T3. Archived/deleted threads are excluded. */
  listThreads(input: { projectId: string; titleContains?: string; settled?: boolean; includeSubagents?: boolean; limit?: number; cursor?: number }): Promise<ThreadList> {
    return this.callTool('t3_thread_list', withoutNulls(input), threadListSchema, { readOnly: true });
  }

  listThreadCatalogPage(input: { projectId: string; includeSubagents: boolean; settled?: boolean; limit: number; cursor: number }) {
    return this.callTool('t3_thread_list', input, threadCatalogPageSchema, { readOnly: true });
  }

  searchThreads(input: { projectId: string; query: string; limit?: number }): Promise<ThreadSearch> {
    return this.callTool('t3_thread_search', withoutNulls(input), threadSearchSchema, { readOnly: true });
  }

  /** Send a message. `clientRequestId` makes T3 deduplicate retries, so callers may repeat it with the same id. */
  sendToThread(input: { threadId: string; message: string; mode?: 'auto' | 'queue' | 'steer'; clientRequestId: string },
    options: Pick<CallOptions, 'beforeSend'> = {}): Promise<SendResult> {
    return this.callTool('t3_thread_send', withoutNulls(input), sendResultSchema, options);
  }

  /** No downstream idempotency key: never retry an ambiguous settlement automatically. */
  settleThread(threadId: string) {
    return this.callTool('t3_thread_organize', { threadId, action: 'settle' },
      z.union([z.looseObject({ sequence: z.number() }), z.looseObject({ settlesWhenTurnEnds: z.literal(true) })]));
  }

  /** Request an interrupt of the thread's active turn. Idempotent per `clientRequestId`. */
  interruptThread(input: { threadId: string; clientRequestId: string; reason?: string }): Promise<InterruptResult> {
    return this.callTool('t3_thread_interrupt', withoutNulls(input), interruptResultSchema);
  }

  /** Ids of pending user questions (no approvals). Session discovery prefers the combined tool, else the legacy trio. */
  async listPendingRequests(threadId: string): Promise<string[]> {
    return (await this.callTool('t3_pending_request_list', { threadId }, pendingRequestListSchema, { readOnly: true })).requestIds;
  }

  readPendingRequest(threadId: string, requestId: string, options: { timeoutMs?: number } = {}): Promise<PendingRequest> {
    return this.callTool('t3_pending_request_read', { threadId, requestId }, pendingRequestSchema, { ...options, readOnly: true });
  }

  /** Answer a pending user question. `answers` is passed through as T3 expects it. */
  async respondToPendingRequest(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<number> {
    return (await this.callTool('t3_pending_request_respond', { threadId, requestId, answers }, respondResultSchema)).sequence;
  }

  async close(): Promise<void> {
    await this.#reset();
  }

  #connect(timeout: number): Connection {
    const token = this.#token();
    if (!token) {
      throw new GatewayError('host_not_enrolled', `Host ${this.hostId} has no T3 credential. Run: t3-fleet-gateway hosts enroll ${this.hostId}`);
    }
    if (this.#connection && this.#connection.token !== token) void this.#reset(this.#connection.generation);
    if (!this.#connection) {
      const client = new Client({ name: GATEWAY_NAME, version: GATEWAY_VERSION });
      const transport = new StreamableHTTPClientTransport(this.#url, {
        authProvider: { token: async () => token },
        ...(this.#observeHttpStatus ? { fetch: async (...args: Parameters<typeof fetch>) => {
          const response = await fetch(...args);
          const [input, init] = args;
          const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
          const url = new URL(response.url);
          if (method === 'POST' && url.origin === this.#url.origin && url.pathname === this.#url.pathname) {
            this.#observeHttpStatus!(response.status);
          }
          return response;
        } } : {}),
      });
      // The SDK does not pass the request signal to notifications/initialized. Close the transport
      // directly on lifetime cancellation, even when connect() has not finished that notification.
      const cancel = () => { void client.close().catch(() => {}); };
      const connecting = client.connect(transport, { timeout, signal: this.#signal }).then(() => client);
      this.#signal?.addEventListener('abort', cancel, { once: true });
      if (this.#signal?.aborted) cancel();
      this.#connection = { client: connecting, instance: client, cancel, token, generation: ++this.#generation };
    }
    return this.#connection;
  }

  /** Close the connection of the given generation, or the current one; a newer connection is left alone. */
  async #reset(generation?: number): Promise<void> {
    const connection = this.#connection;
    if (!connection || (generation !== undefined && connection.generation !== generation)) return;
    this.#connection = undefined;
    this.#signal?.removeEventListener('abort', connection.cancel);
    try {
      await connection.instance.close();
    } catch {
      // The connection already failed; nothing to close.
    }
  }

  /**
   * Map a transport failure to a stable code and a delivery verdict. Anything before the call was
   * sent (connecting, initializing), a refused connection, and HTTP 4xx answers mean T3 never ran
   * the tool. Timeouts, resets and 5xx answers after sending leave the outcome unknown.
   */
  #translate(error: unknown, sent: boolean): T3TransportError {
    const status = httpStatus(error);
    if (error instanceof UnauthorizedError || status === 401 || status === 403) {
      return new T3TransportError(
        't3_unauthorized',
        `T3 on host ${this.hostId} rejected the gateway's credential. Run: t3-fleet-gateway hosts enroll ${this.hostId}`,
        'not_delivered',
        { cause: error },
      );
    }
    const delivery: Delivery = !sent || causeCode(error) !== undefined || (status !== undefined && status < 500) ? 'not_delivered' : 'unknown';
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
      return new T3TransportError('t3_timeout', `T3 on host ${this.hostId} did not answer in time`, delivery, { cause: error });
    }
    const detail = status === undefined ? '' : ` (HTTP ${status})`;
    if (delivery === 'unknown') {
      return new T3TransportError('t3_response_lost', `Lost the response from T3 on host ${this.hostId}${detail}`, delivery, { cause: error });
    }
    return new T3TransportError('host_unreachable', `Cannot reach T3 on host ${this.hostId}${detail}`, delivery, { cause: error });
  }
}

/** Drop null and undefined fields so optional T3 inputs are omitted rather than sent as null. */
function withoutNulls<T extends object>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}
