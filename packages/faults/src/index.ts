// A Node.js test tool: the one package whose src/ may use Node.js APIs (AGENTS.md, ADR 0032).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * What the proxy does to a JSON-RPC request in place of passing the node's answer on.
 *
 * - `hang`: never answers, like an unresponsive provider; the client's own timeout ends the request.
 * - `http`: answers with this HTTP status and no JSON-RPC body, such as 429 for a rate limit.
 * - `rpc-error`: answers with a JSON-RPC error, such as -32005 (limit exceeded) or -32603 (internal error).
 * - `reset`: resets the connection (a TCP RST) before any byte of the answer reaches the client.
 * - `drop`: closes the connection (a TCP FIN) before sending any byte.
 * - `result`: answers with `result(nodeResult, call)` in place of the node's result, such as a receipt that stays
 *   `null`, a malformed block or a chain id that changes between calls (`call` counts this method's requests since
 *   the last `set()`, from 1).
 * - `previous`: answers with the result the previous request of this method got, whatever it asked for, as a node
 *   behind a load balancer that mixes up answers does; the first request gets its own.
 *
 * `hang`, `http`, `rpc-error`, `reset` and `drop` never reach the node; `result` and `previous` send the request on
 * once and answer 502 when the node's answer is not JSON.
 */
export type Fault =
  | { kind: 'hang' }
  | { kind: 'http'; status: number }
  | { kind: 'rpc-error'; code: number; message?: string | undefined }
  | { kind: 'reset' }
  | { kind: 'drop' }
  | { kind: 'result'; result: (nodeResult: unknown, call: number) => unknown }
  | { kind: 'previous' };

/** A fault and the requests of one method it applies to. */
export interface FaultRule {
  /** What the proxy does to the requests the rule applies to. */
  fault: Fault;
  /** Requests of the method passed on untouched before the fault applies (default 0). */
  after?: number | undefined;
  /** How many requests the fault applies to (default: every request after `after`). */
  times?: number | undefined;
}

/** Options of {@link startFaultProxy}. */
export interface FaultProxyOptions {
  /**
   * Accept an upstream that is not loopback (default false). Without it, only an IPv4 address of `127.0.0.0/8`,
   * `[::1]` and `localhost` are accepted, judged from the URL as written, without resolving names.
   */
  allowRemoteUpstream?: boolean | undefined;
}

/** A running fault proxy. */
export interface FaultProxy {
  /** URL of the proxy, on a free port of 127.0.0.1, for the client's HTTP transport. */
  readonly url: string;
  /**
   * Replaces every rule, by JSON-RPC method; the counts of requests start again from 0 and the results kept for
   * `previous` are forgotten. Of several rules for one method, the first that applies to a request is used. A bare
   * fault applies to every request of its method.
   */
  set(rules: Record<string, Fault | FaultRule | FaultRule[]>): void;
  /** Requests of every method the proxy received since the last `set()`, by method. */
  requests(): Record<string, number>;
  /** Requests of `method` the proxy received since the last `set()`, faulted ones included. */
  requests(method: string): number;
  /** Closes the proxy and every connection it holds, hanging ones included. */
  stop(): Promise<void>;
}

interface RpcRequest {
  id?: unknown;
  method?: unknown;
}

interface Upstream {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** An IPv4 address in 127.0.0.0/8, as the URL parser writes it. */
const loopbackV4 = /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The upstream as a URL, or an error that says why it is refused. */
function checkUpstream(upstream: string, options: FaultProxyOptions): URL {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new TypeError(`fault proxy: the upstream is not a URL: ${JSON.stringify(upstream)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(
      `fault proxy: the upstream must be an http: or https: URL, not ${url.protocol}`,
    );
  }
  const { hostname } = url;
  const loopback = hostname === 'localhost' || hostname === '[::1]' || loopbackV4.test(hostname);
  if (!loopback && options.allowRemoteUpstream !== true) {
    throw new Error(
      `fault proxy: the upstream host ${hostname} is not loopback; pass allowRemoteUpstream: true to use it`,
    );
  }
  return url;
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

/** The `result` of a JSON-RPC answer; throws when the answer is not JSON. */
const resultOf = (text: string): unknown =>
  (JSON.parse(text) as { result?: unknown } | null)?.result;

/**
 * Starts an HTTP proxy in front of a JSON-RPC node that injects faults per JSON-RPC method. It listens on a free
 * port of 127.0.0.1 only, and sends at most one request to the upstream per request it receives, never following a
 * redirect. Batches (JSON arrays) and bodies that are not JSON are passed on untouched. Node.js only.
 *
 * @param upstream - URL of the node, `http:` or `https:`; loopback unless `allowRemoteUpstream` is set.
 * @returns The running proxy; rejects when the upstream is refused or the port cannot be bound.
 */
export async function startFaultProxy(
  upstream: string,
  options: FaultProxyOptions = {},
): Promise<FaultProxy> {
  const target = checkUpstream(upstream, options);
  let rules = new Map<string, FaultRule[]>();
  let counts = new Map<string, number>();
  const previous = new Map<string, unknown>();
  const sockets = new Set<Socket>();

  /** One request to the upstream, redirects passed back as they are. */
  const forward = async (body: string): Promise<Upstream> => {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'manual',
    });
    const headers: Record<string, string> = {
      'content-type': response.headers.get('content-type') ?? 'application/json',
    };
    const location = response.headers.get('location');
    if (location !== null) headers.location = location;
    return { status: response.status, headers, text: await response.text() };
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
    if (rpc === undefined || method === undefined) {
      const passed = await forward(body);
      response.writeHead(passed.status, passed.headers);
      response.end(passed.text);
      return;
    }
    const call = (counts.get(method) ?? 0) + 1;
    counts.set(method, call);
    const rule = rules
      .get(method)
      ?.find(
        ({ after = 0, times = Number.POSITIVE_INFINITY }) => call > after && call <= after + times,
      );

    if (rule === undefined) {
      const passed = await forward(body);
      try {
        previous.set(method, resultOf(passed.text));
      } catch {
        // Not JSON: nothing to replay.
      }
      response.writeHead(passed.status, passed.headers);
      response.end(passed.text);
      return;
    }
    const { fault } = rule;
    const id = rpc.id ?? null;
    switch (fault.kind) {
      case 'hang':
        return;
      case 'http':
        response.writeHead(fault.status, { 'content-type': 'text/plain' });
        response.end('injected fault');
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
        // The headers and the partial body are still corked in the socket when it is reset, so the client gets an RST
        // and no byte: the fault the adapters' fault tests were pinned against (see this package's AGENTS.md).
        response.write('{"jsonrpc":"2.0","id":');
        response.socket?.resetAndDestroy();
        return;
      case 'drop':
        request.socket.destroy();
        return;
      case 'result': {
        const nodeResult = resultOf((await forward(body)).text);
        answer(response, { jsonrpc: '2.0', id, result: fault.result(nodeResult, call) });
        return;
      }
      case 'previous': {
        const own = resultOf((await forward(body)).text);
        const replayed = previous.has(method) ? previous.get(method) : own;
        previous.set(method, own);
        answer(response, { jsonrpc: '2.0', id, result: replayed });
        return;
      }
    }
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('fault proxy: the upstream answer could not be used');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  function requests(): Record<string, number>;
  function requests(method: string): number;
  function requests(method?: string): Record<string, number> | number {
    return method === undefined ? Object.fromEntries(counts) : (counts.get(method) ?? 0);
  }

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
    requests,
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
