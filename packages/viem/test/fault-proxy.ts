import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * What the proxy does to a JSON-RPC request instead of passing the node's answer on:
 * - `hang`: never answers, like an unresponsive provider; the client's own request timeout ends the request
 * - `http`: answers with this HTTP status and no JSON-RPC body, e.g. 429 for a rate limit
 * - `rpc-error`: answers with a JSON-RPC error, e.g. -32005 (limit exceeded) or -32603 (internal error)
 * - `reset`: sends the headers and part of the body, then resets the connection
 * - `result`: answers with `result(nodeResult, call)` in place of the node's result: a receipt that stays `null`, a
 *   malformed receipt or block, or a chain id that changes between calls (`call` counts this method's requests, from 1)
 * - `previous`: answers with the result the previous request of this method got, whatever it asked for, as a node
 *   behind a load balancer that mixes up responses does; the first request gets its own
 */
export type Fault =
  | { kind: 'hang' }
  | { kind: 'http'; status: number }
  | { kind: 'rpc-error'; code: number; message?: string }
  | { kind: 'reset' }
  | { kind: 'result'; result: (nodeResult: unknown, call: number) => unknown }
  | { kind: 'previous' };

export interface FaultRule {
  fault: Fault;
  /** Requests of the method passed on untouched before the fault applies (default 0). */
  after?: number;
  /** How many requests the fault applies to (default: all). */
  times?: number;
}

export interface FaultProxy {
  /** URL of the proxy, for viem's `http()` transport. */
  url: string;
  /**
   * Replaces every rule; the counts of requests per method start again from 0. Of several rules for one method, the
   * first that applies to a request is used.
   */
  set(rules: Record<string, Fault | FaultRule | FaultRule[]>): void;
  /** Requests of `method` the proxy received since the last `set()`. */
  requests(method: string): number;
  /** Closes the proxy and every connection it holds, including hanging ones. */
  stop(): Promise<void>;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });

const answer = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

/**
 * An HTTP proxy in front of a JSON-RPC node (Anvil in tests) on a free port of 127.0.0.1 that injects faults per
 * JSON-RPC method. Test code only: it uses nothing but `node:http`. Batched requests are passed on untouched.
 */
export async function startFaultProxy(upstream: string): Promise<FaultProxy> {
  let rules = new Map<string, FaultRule[]>();
  let counts = new Map<string, number>();
  const previous = new Map<string, unknown>();
  const sockets = new Set<Socket>();

  const forward = async (body: string): Promise<{ status: number; text: string }> => {
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return { status: response.status, text: await response.text() };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request);
    let rpc: RpcRequest | undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        rpc = parsed as RpcRequest;
    } catch {
      // Not JSON: passed on as it is.
    }
    const method = typeof rpc?.method === 'string' ? rpc.method : undefined;
    const call = method === undefined ? 0 : (counts.get(method) ?? 0) + 1;
    if (method !== undefined) counts.set(method, call);
    const rule = (method === undefined ? undefined : rules.get(method))?.find(
      ({ after = 0, times = Number.POSITIVE_INFINITY }) => call > after && call <= after + times,
    );

    if (!rule || !rpc || method === undefined) {
      const { status, text } = await forward(body);
      if (method !== undefined) {
        try {
          previous.set(method, (JSON.parse(text) as { result?: unknown }).result);
        } catch {
          // Not JSON: nothing to replay.
        }
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(text);
      return;
    }
    const { fault } = rule;
    const id = rpc.id ?? null;
    switch (fault.kind) {
      case 'hang':
        return;
      case 'http':
        response.writeHead(fault.status, { 'content-type': 'text/plain' });
        response.end('fault');
        return;
      case 'rpc-error':
        answer(response, {
          jsonrpc: '2.0',
          id,
          error: { code: fault.code, message: fault.message ?? 'injected fault' },
        });
        return;
      case 'reset':
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        response.write('{"jsonrpc":"2.0","id":');
        response.socket?.resetAndDestroy();
        return;
      case 'result': {
        const { text } = await forward(body);
        const nodeResult = (JSON.parse(text) as { result?: unknown }).result;
        answer(response, { jsonrpc: '2.0', id, result: fault.result(nodeResult, call) });
        return;
      }
      case 'previous': {
        const { text } = await forward(body);
        const own = (JSON.parse(text) as { result?: unknown }).result;
        const replayed = previous.has(method) ? previous.get(method) : own;
        previous.set(method, own);
        answer(response, { jsonrpc: '2.0', id, result: replayed });
        return;
      }
    }
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    set(next) {
      rules = new Map(
        Object.entries(next).map(([method, rule]) => [
          method,
          Array.isArray(rule) ? rule : 'fault' in rule ? [rule] : [{ fault: rule }],
        ]),
      );
      counts = new Map();
      previous.clear();
    },
    requests: (method) => counts.get(method) ?? 0,
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
