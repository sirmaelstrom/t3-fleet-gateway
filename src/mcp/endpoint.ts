import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { readBody, sendJson } from '../http/io.ts';
import type { Route } from '../http/server.ts';
import { exchangeSignal, sendWebResponse, toWebRequest } from '../http/web.ts';
import type { Logger } from '../log.ts';
import type { ClientStore } from '../oauth/clients.ts';
import { resourceMetadataUrl } from '../oauth/metadata.ts';
import type { TokenService, VerifiedAccessToken } from '../oauth/tokens.ts';
import { GATEWAY_NAME, GATEWAY_VERSION } from '../version.ts';
import { registerTools, type GatewayTool, type ToolContext } from './tools.ts';

// 10 MiB decoded attachments expand to about 14 MiB of base64, plus bounded JSON/text.
export const MCP_BODY_LIMIT = 15 * 1024 * 1024;

export interface McpEndpointDependencies {
  publicUrl: string;
  allowedOrigins: readonly string[];
  tokens: TokenService;
  clients: ClientStore;
  tools: readonly GatewayTool[];
  logger: Logger;
}

const BEARER = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i;
/**
 * The transports refuse a POST whose Accept header does not list both types (406). The gateway
 * always answers JSON, so clients that send only `application/json`, a wildcard, or no Accept are served too.
 */
const POST_ACCEPT = 'application/json, text/event-stream';

/**
 * POST /mcp: bearer-authenticated Streamable HTTP, stateless, JSON responses. 2026-era requests go
 * to the SDK handler; 2025-era requests get a one-shot stateless transport with JSON responses.
 * Requests without MCP-Protocol-Version are served as 2025-era traffic (the spec's default).
 */
export function createMcpEndpoint(deps: McpEndpointDependencies): { route: Route; close(): Promise<void> } {
  const { publicUrl, logger } = deps;
  const allowedOrigins = new Set([publicUrl, ...deps.allowedOrigins]);
  const metadataUrl = resourceMetadataUrl(publicUrl);

  const buildServer = (context: ToolContext): McpServer => {
    const server = new McpServer({ name: GATEWAY_NAME, version: GATEWAY_VERSION });
    registerTools(server, deps.tools, context, logger);
    return server;
  };
  const contextFrom = (authInfo: AuthInfo | undefined): ToolContext => ({
    clientId: authInfo?.clientId ?? '',
    onToolCall: () => {
      const id = authInfo?.extra?.operatorTokenId;
      if (typeof id === 'string') {
        try { deps.tokens.recordOperatorCall(id); } catch { logger.warn('mcp.token_usage_record_failed'); }
      }
    },
    scopes: (authInfo?.scopes ?? []) as ToolContext['scopes'],
  });
  const modern = createMcpHandler(({ authInfo }) => buildServer(contextFrom(authInfo)), {
    legacy: 'reject',
    maxRequestBodySize: MCP_BODY_LIMIT,
    onerror: (error) => logger.warn('mcp.protocol_error', { detail: error.name }),
  });

  const challenge = (res: ServerResponse, error?: string): void => {
    const params = [`resource_metadata="${metadataUrl}"`];
    if (error) params.unshift(`error="${error}"`);
    sendJson(res, 401, { error: error ?? 'unauthorized', error_description: 'Bearer token required' }, { 'www-authenticate': `Bearer ${params.join(', ')}` });
  };

  const authenticate = (req: IncomingMessage, res: ServerResponse): VerifiedAccessToken | undefined => {
    const header = req.headers.authorization;
    if (!header) {
      challenge(res);
      return undefined;
    }
    const token = BEARER.exec(header)?.[1];
    const verified = token ? deps.tokens.verifyAccessToken(token) : undefined;
    if (!verified) {
      logger.info('mcp.unauthorized', { reason: token ? 'invalid_token' : 'malformed_header' });
      challenge(res, 'invalid_token');
      return undefined;
    }
    return verified;
  };

  const serveLegacy = async (request: Request, authInfo: AuthInfo): Promise<Response> => {
    const server = buildServer(contextFrom(authInfo));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { authInfo });
    } finally {
      // JSON mode builds the whole body before returning, so the per-request server can go.
      void server.close();
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      logger.warn('mcp.origin_rejected');
      sendJson(res, 403, { error: 'forbidden', error_description: 'Origin not allowed' });
      return;
    }
    const verified = authenticate(req, res);
    if (!verified) return;
    deps.clients.touch(verified.clientId);
    res.once('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          deps.clients.recordMcpSuccess(verified.clientId);
        } catch {
          // Observability must not change the response or grant security, or crash the server after a response.
          logger.warn('mcp.success_record_failed', { clientId: verified.clientId });
        }
      }
    });
    const authInfo: AuthInfo = {
      token: '',
      extra: { operatorTokenId: verified.operatorTokenId },
      clientId: verified.clientId,
      scopes: verified.scopes,
      expiresAt: Math.floor(verified.expiresAt / 1000),
      resource: new URL(verified.resource),
    };
    // Tied to this exchange only: a client that goes away ends its own subscription, never work it already started.
    const signal = exchangeSignal(req, res);
    const body = req.method === 'POST' ? await readBody(req, MCP_BODY_LIMIT) : undefined;
    const request = toWebRequest(req, body, publicUrl, signal);
    if (req.method === 'POST') request.headers.set('accept', POST_ACCEPT);
    if (await isLegacyRequest(request, undefined, { maxRequestBodySize: MCP_BODY_LIMIT })) {
      if (req.method !== 'POST') {
        // Stateless: no standalone SSE stream to open and no session to delete.
        sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return;
      }
      await sendWebResponse(res, await serveLegacy(request, authInfo));
      return;
    }
    await sendWebResponse(res, await modern.fetch(request, { authInfo }));
  };

  return { route: { path: '/mcp', methods: { POST: handle, GET: handle, DELETE: handle } }, close: () => modern.close() };
}
