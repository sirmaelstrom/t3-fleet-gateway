import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The abort signal of one HTTP exchange. It fires when the client goes away: the request closes before its body has
 * arrived in full, or the connection closes before the response has been sent in full. A request whose body was read
 * and a response that ended normally never fire it. Handlers that stream (an SSE subscription) stop on it.
 */
export function exchangeSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  req.once('close', () => {
    if (!req.complete) controller.abort();
  });
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** Build a web-standard Request from a Node request whose body has already been read. */
export function toWebRequest(req: IncomingMessage, body: Buffer | undefined, origin: string, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && body !== undefined;
  return new Request(new URL(req.url ?? '/', origin), { method, headers, ...(hasBody ? { body: new Uint8Array(body) } : {}), ...(signal ? { signal } : {}) });
}

/**
 * Write a web-standard Response to a Node response, streaming the body (SSE included). When the connection closes first,
 * the body is cancelled, so whatever produces it (a subscription and its listeners) is released and nothing more is written.
 */
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  if (res.destroyed) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  res.once('close', cancel);
  let ended = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (res.destroyed) return;
      if (next.done) break;
      res.write(next.value);
    }
    res.end();
    ended = true;
  } finally {
    res.off('close', cancel);
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
