import assert from 'node:assert/strict';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { describe, test } from 'node:test';
import { InMemoryServerEventBus } from '@modelcontextprotocol/server';
import { INITIALIZE, mcpPost, startTestGateway } from './helpers/gateway.ts';
import { signIn } from './helpers/oauthFlow.ts';

const MODERN = '2026-07-28';
// The longest a released subscription may take to drop its listener. A release resolves the wait at once; the bound only
// turns a listener that is never released into an assertion failure instead of the test timeout.
const RELEASE_BOUND_MS = 5_000;

/** Counts the SDK's live event-bus listeners (each open subscription holds one) and lets a test wait, bounded, for a count. */
function trackListeners(t: import('node:test').TestContext) {
  const subscribe = InMemoryServerEventBus.prototype.subscribe;
  let active = 0;
  let bus: InMemoryServerEventBus | undefined;
  const waiters: { count: number; resolve: () => void }[] = [];
  const settle = () => {
    for (const waiter of waiters.filter((candidate) => candidate.count === active)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  InMemoryServerEventBus.prototype.subscribe = function (this: InMemoryServerEventBus, ...args: Parameters<typeof subscribe>) {
    bus = this;
    const unsubscribe = subscribe.apply(this, args);
    active++;
    settle();
    let released = false;
    return () => {
      unsubscribe();
      if (released) return;
      released = true;
      active--;
      settle();
    };
  };
  t.after(() => {
    InMemoryServerEventBus.prototype.subscribe = subscribe;
  });
  return {
    get active() {
      return active;
    },
    get bus() {
      return bus;
    },
    /** Resolves as soon as the count is `count`, or after `boundMs` with whatever it is then; callers assert the result. */
    until: (count: number, boundMs: number) =>
      active === count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const waiter = {
              count,
              resolve: () => {
                clearTimeout(timer);
                resolve();
              },
            };
            const timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              resolve();
            }, boundMs);
            waiters.push(waiter);
          }),
  };
}

/** Open a 2026-era `subscriptions/listen` stream; resolves with the request once the acknowledgement has arrived. */
function listen(baseUrl: string, token: string, id: string): Promise<{ request: ClientRequest; first: string }> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'subscriptions/listen',
    params: {
      notifications: { toolsListChanged: true },
      _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} },
    },
  });
  const url = new URL('/mcp', baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          'mcp-protocol-version': MODERN,
          'mcp-method': 'subscriptions/listen',
        },
      },
      (response) => {
        response.once('data', (chunk: Buffer) => resolve({ request, first: chunk.toString('utf8') }));
        response.on('error', () => {});
      },
    );
    request.on('error', (error) => {
      if (!request.destroyed) reject(error);
    });
    request.end(body);
  });
}

describe('MCP subscriptions and client disconnects', () => {
  test('a client that disconnects from subscriptions/listen releases its subscription without an endpoint shutdown', async (t) => {
    const listeners = trackListeners(t);
    const gw = await startTestGateway(t);
    const { tokens } = await signIn(gw.baseUrl, gw.mintApprovalCode);
    assert.equal(listeners.active, 0);

    for (const round of [1, 2]) {
      const { request, first } = await listen(gw.baseUrl, tokens.access_token, `listen-${round}`);
      assert.match(first, /notifications\/subscriptions\/acknowledged/);
      assert.match(first, /"toolsListChanged":true/);
      assert.equal(listeners.active, 1, 'an open subscription holds one listener');
      request.destroy();
      await listeners.until(0, RELEASE_BOUND_MS);
      assert.equal(listeners.active, 0, `round ${round}: the disconnected subscription released its listener`);
      // A change published after the disconnect reaches no one.
      listeners.bus?.publish({ kind: 'tools_list_changed' });
      assert.equal(listeners.active, 0, `round ${round}: still at the baseline after a later change`);
    }

    // The endpoint still serves ordinary requests.
    const init = await mcpPost(gw.baseUrl, tokens.access_token, INITIALIZE);
    assert.equal(init.status, 200);
    const list = await mcpPost(gw.baseUrl, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200);
  });
});
