// The fault proxy against a small local HTTP server standing in for the node, in the order of ADR 0032 point 8:
// the upstream check, redirects, the listen address, one upstream request per client request, each kind, the
// counts, node answers that are not JSON, and stopping and binding.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, Server as NetServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Fault, type FaultProxy, type FaultRule, startFaultProxy } from '../src/index.js';

interface Received {
  body: string;
  method: string | undefined;
}

interface StandIn {
  url: string;
  /** Every request the stand-in received, in order. */
  received: Received[];
  stop(): Promise<void>;
}

type Respond = (request: Received, response: ServerResponse, count: number) => void;

/** Answers `<method>#<n>`, n counting this method's requests at the node from 1. */
const jsonRpc: Respond = ({ body, method }, response, count) => {
  const { id } = JSON.parse(body) as { id?: unknown };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: `${method}#${count}` }));
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A local HTTP server as the node: JSON-RPC answers by default, or what `respond` writes. */
async function startStandIn(respond: Respond = jsonRpc): Promise<StandIn> {
  const received: Received[] = [];
  const counts = new Map<string, number>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      let method: string | undefined;
      try {
        const parsed = JSON.parse(body) as { method?: unknown };
        if (typeof parsed?.method === 'string') method = parsed.method;
      } catch {
        // Not JSON.
      }
      const entry = { body, method };
      received.push(entry);
      const count = (counts.get(method ?? '') ?? 0) + 1;
      counts.set(method ?? '', count);
      respond(entry, response, count);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const standIn = {
    url: `http://127.0.0.1:${port}/`,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  cleanups.push(standIn.stop);
  return standIn;
}

async function proxyTo(upstream: string, options?: { allowRemoteUpstream?: boolean }) {
  const proxy = await startFaultProxy(upstream, options);
  cleanups.push(() => proxy.stop());
  return proxy;
}

let nextId = 1;
const request = (method: string, id: unknown = nextId++) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: [] });

/** Posts a body to the proxy and reads the whole answer. */
async function post(
  proxy: FaultProxy,
  body: string,
  init: { signal?: AbortSignal } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(proxy.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    redirect: 'manual',
    ...init,
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/** The JSON-RPC answer to one call of `method`. */
async function call(proxy: FaultProxy, method: string, id?: unknown): Promise<unknown> {
  const { status, text } = await post(proxy, request(method, id));
  expect(status).toBe(200);
  return JSON.parse(text);
}

const resultOf = async (proxy: FaultProxy, method: string): Promise<unknown> =>
  ((await call(proxy, method)) as { result?: unknown }).result;

/** Sends a raw HTTP request and collects every byte until the connection closes. */
function rawExchange(
  url: string,
  body: string,
): Promise<{ bytes: string; error: NodeJS.ErrnoException | undefined }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    let bytes = '';
    let error: NodeJS.ErrnoException | undefined;
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `POST / HTTP/1.1\r\nhost: ${hostname}:${port}\r\ncontent-type: application/json\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      bytes += chunk;
    });
    socket.on('error', (cause: NodeJS.ErrnoException) => {
      error = cause;
    });
    socket.on('close', () => resolve({ bytes, error }));
  });
}

/** Whether a TCP connection to host and port is accepted within a second. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('1. the upstream check', () => {
  it.each([
    'http://127.0.0.1:8545',
    'http://127.0.0.2:8545/',
    'http://127.255.255.254:8545/rpc',
    'http://[::1]:8545',
    'http://localhost:8545',
    'http://LOCALHOST:8545',
    'https://127.0.0.1:8545',
    'http://127.0.0.1',
  ])('accepts the loopback upstream %s', async (upstream) => {
    const proxy = await proxyTo(upstream);
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it.each([
    ['a public address', 'http://8.8.8.8:8545'],
    ['a public IPv6 address', 'http://[2001:4860:4860::8888]:8545'],
    ['a private address', 'http://10.0.0.1:8545'],
    ['a private address', 'http://192.168.1.10:8545'],
    ['an unspecified address', 'http://0.0.0.0:8545'],
    ['a link-local IPv6 address', 'http://[fe80::1]:8545'],
    ['an IPv4-mapped loopback address', 'http://[::ffff:127.0.0.1]:8545'],
    ['a hostname', 'http://example.com:8545'],
    ['a compose service name', 'http://anvil:8545'],
    ['a hostname that starts like a loopback address', 'http://127.0.0.1.example.com:8545'],
    ['a hostname that starts like localhost', 'http://localhost.example.com:8545'],
    ['localhost with a trailing dot', 'http://localhost.:8545'],
    ['a subdomain of localhost', 'http://node.localhost:8545'],
    ['a WebSocket URL', 'ws://127.0.0.1:8545'],
    ['a file URL', 'file:///etc/hosts'],
    ['an FTP URL', 'ftp://localhost/'],
    ['a string that is not a URL', 'not a url'],
    ['an empty string', ''],
  ])('refuses %s (%s)', async (_, upstream) => {
    await expect(startFaultProxy(upstream)).rejects.toThrow(/upstream/);
  });

  it.each([
    'http://anvil:8545',
    'https://rpc.example.com',
    'http://10.0.0.1:8545',
  ])('accepts %s with allowRemoteUpstream: true', async (upstream) => {
    const proxy = await proxyTo(upstream, { allowRemoteUpstream: true });
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it.each([
    'ws://anvil:8545',
    'file:///etc/hosts',
    'not a url',
  ])('refuses %s with allowRemoteUpstream: true too', async (upstream) => {
    await expect(startFaultProxy(upstream, { allowRemoteUpstream: true })).rejects.toThrow(
      /upstream/,
    );
  });

  it('refuses a remote upstream with allowRemoteUpstream: false', async () => {
    await expect(
      startFaultProxy('http://anvil:8545', { allowRemoteUpstream: false }),
    ).rejects.toThrow(/upstream/);
  });

  it('passes requests on to a loopback upstream given by name', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url.replace('127.0.0.1', 'localhost'));
    expect(await resultOf(proxy, 'eth_chainId')).toBe('eth_chainId#1');
  });
});

describe('2. redirects', () => {
  it.each([301, 302, 303, 307, 308])(
    'passes a %d of the upstream back as it is and never follows it',
    async (status) => {
      const second = await startStandIn();
      const first = await startStandIn((_, response) => {
        response.writeHead(status, { location: second.url });
        response.end();
      });
      const proxy = await proxyTo(first.url);
      const answer = await post(proxy, request('eth_blockNumber'));
      expect(answer.status).toBe(status);
      expect(answer.headers.get('location')).toBe(second.url);
      expect(first.received).toHaveLength(1);
      await delay(50);
      expect(second.received).toHaveLength(0);
    },
  );

  it('does not follow a redirect under a rule that reads the result either', async () => {
    const second = await startStandIn();
    const first = await startStandIn((_, response) => {
      response.writeHead(307, { location: second.url });
      response.end();
    });
    const proxy = await proxyTo(first.url);
    proxy.set({ eth_blockNumber: { kind: 'result', result: () => '0x1' } });
    expect((await post(proxy, request('eth_blockNumber'))).status).toBe(502);
    await delay(50);
    expect(second.received).toHaveLength(0);
  });
});

describe('3. the listen address', () => {
  it('listens on 127.0.0.1 only', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    const { hostname, port } = new URL(proxy.url);
    expect(hostname).toBe('127.0.0.1');
    expect(await canConnect('127.0.0.1', Number(port))).toBe(true);
    expect(await canConnect('::1', Number(port))).toBe(false);
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((address) => address !== undefined && !address.internal)
      .map((address) => address?.address ?? '');
    for (const address of external) expect(await canConnect(address, Number(port))).toBe(false);
  });
});

describe('4. one upstream request per client request', () => {
  const kinds: [string, Fault, number][] = [
    ['hang', { kind: 'hang' }, 0],
    ['http', { kind: 'http', status: 429 }, 0],
    ['rpc-error', { kind: 'rpc-error', code: -32005 }, 0],
    ['reset', { kind: 'reset' }, 0],
    ['drop', { kind: 'drop' }, 0],
    ['result', { kind: 'result', result: (value) => value }, 1],
    ['previous', { kind: 'previous' }, 1],
  ];

  it.each(kinds)('%s: %i upstream requests per client request', async (_, fault, expected) => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: fault });
    for (let i = 1; i <= 3; i++) {
      await post(proxy, request('eth_call'), { signal: AbortSignal.timeout(300) }).catch(
        () => undefined,
      );
      await delay(20);
      expect(node.received).toHaveLength(i * expected);
    }
  });

  it('a request without a rule reaches the node once', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    await call(proxy, 'eth_chainId');
    await call(proxy, 'eth_chainId');
    expect(node.received).toHaveLength(2);
  });

  it.each([429, 500, 503])(
    'an upstream answer of %d goes back once, without a retry',
    async (status) => {
      const node = await startStandIn((_, response) => {
        response.writeHead(status, { 'content-type': 'text/plain' });
        response.end('busy');
      });
      const proxy = await proxyTo(node.url);
      const answer = await post(proxy, request('eth_chainId'));
      expect(answer).toMatchObject({ status, text: 'busy' });
      await delay(50);
      expect(node.received).toHaveLength(1);
    },
  );
});

describe('5. the kinds of faults', () => {
  it('hang never answers', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'hang' } });
    await expect(
      post(proxy, request('eth_call'), { signal: AbortSignal.timeout(300) }),
    ).rejects.toThrow();
    expect(proxy.requests('eth_call')).toBe(1);
  });

  it('http answers with the status and no JSON-RPC body', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'http', status: 429 } });
    const answer = await post(proxy, request('eth_call'));
    expect(answer.status).toBe(429);
    expect(answer.text).not.toMatch(/jsonrpc/);
  });

  it('rpc-error answers with a JSON-RPC error with the request id', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({
      eth_call: { kind: 'rpc-error', code: -32005 },
      eth_getLogs: { kind: 'rpc-error', code: -32603, message: 'internal error' },
    });
    expect(await call(proxy, 'eth_call', 'a')).toEqual({
      jsonrpc: '2.0',
      id: 'a',
      error: { code: -32005, message: 'injected fault' },
    });
    expect(await call(proxy, 'eth_getLogs', 7)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32603, message: 'internal error' },
    });
  });

  it('rpc-error answers a request without an id with id null', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'rpc-error', code: -32005 } });
    const { text } = await post(proxy, JSON.stringify({ jsonrpc: '2.0', method: 'eth_call' }));
    expect(JSON.parse(text)).toMatchObject({ id: null, error: { code: -32005 } });
  });

  it('reset sends the headers and part of the body, then resets the connection', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'reset' } });
    const { bytes } = await rawExchange(proxy.url, request('eth_call'));
    expect(bytes).toMatch(/^HTTP\/1\.1 200 /);
    expect(bytes).toMatch(/content-length: 1000/i);
    const body = bytes.slice(bytes.indexOf('\r\n\r\n') + 4);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThan(1000);
    await expect(post(proxy, request('eth_call'))).rejects.toThrow();
  });

  it('drop closes the connection before any byte', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'drop' } });
    expect((await rawExchange(proxy.url, request('eth_call'))).bytes).toBe('');
    await expect(post(proxy, request('eth_call'))).rejects.toThrow();
  });

  it('result replaces the node result with a function of it and of the call count', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    const seen: [unknown, number][] = [];
    proxy.set({
      eth_getTransactionReceipt: {
        kind: 'result',
        result: (nodeResult, count) => {
          seen.push([nodeResult, count]);
          return count === 1 ? null : { replaced: nodeResult };
        },
      },
    });
    expect(await call(proxy, 'eth_getTransactionReceipt', 3)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: null,
    });
    expect(await resultOf(proxy, 'eth_getTransactionReceipt')).toEqual({
      replaced: 'eth_getTransactionReceipt#2',
    });
    expect(seen).toEqual([
      ['eth_getTransactionReceipt#1', 1],
      ['eth_getTransactionReceipt#2', 2],
    ]);
  });

  it('previous answers with the result of the previous request of the method', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_blockNumber: { kind: 'previous' } });
    expect(await resultOf(proxy, 'eth_blockNumber')).toBe('eth_blockNumber#1');
    expect(await resultOf(proxy, 'eth_blockNumber')).toBe('eth_blockNumber#1');
    expect(await resultOf(proxy, 'eth_blockNumber')).toBe('eth_blockNumber#2');
    expect(node.received).toHaveLength(3);
  });

  it('previous replays a result that was passed on before the rule applied', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_blockNumber: { fault: { kind: 'previous' }, after: 1 } });
    expect(await resultOf(proxy, 'eth_blockNumber')).toBe('eth_blockNumber#1');
    expect(await resultOf(proxy, 'eth_blockNumber')).toBe('eth_blockNumber#1');
  });

  it('after passes requests on before the fault, times limits it', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { fault: { kind: 'rpc-error', code: -32005 }, after: 2, times: 2 } });
    const outcomes = [];
    for (let i = 0; i < 6; i++) {
      const answer = (await call(proxy, 'eth_call')) as { error?: unknown };
      outcomes.push(answer.error === undefined ? 'node' : 'fault');
    }
    expect(outcomes).toEqual(['node', 'node', 'fault', 'fault', 'node', 'node']);
    expect(node.received).toHaveLength(4);
  });

  it('a fault without after or times applies to every request', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { fault: { kind: 'http', status: 503 } } });
    for (let i = 0; i < 4; i++) expect((await post(proxy, request('eth_call'))).status).toBe(503);
    expect(node.received).toHaveLength(0);
  });

  it('uses the first rule that applies, of several for one method', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    const rules: FaultRule[] = [
      { fault: { kind: 'http', status: 500 }, times: 1 },
      { fault: { kind: 'rpc-error', code: -32005 }, times: 2 },
      { fault: { kind: 'http', status: 429 }, after: 4, times: 1 },
    ];
    proxy.set({ eth_call: rules });
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const { status, text } = await post(proxy, request('eth_call'));
      statuses.push(status === 200 ? ((JSON.parse(text).error?.code as number) ?? 'node') : status);
    }
    // The second rule counts from the first request too, so it covers the second only.
    expect(statuses).toEqual([500, -32005, 'node', 'node', 429, 'node']);
  });

  it('applies a method rule to that method only', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'http', status: 429 } });
    expect(await resultOf(proxy, 'eth_chainId')).toBe('eth_chainId#1');
  });

  it('passes a batch on untouched, whatever the rules of its methods', async () => {
    const node = await startStandIn((_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[{"jsonrpc":"2.0","id":1,"result":"0x1"}]');
    });
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'http', status: 429 } });
    const batch = `[${request('eth_call', 1)}]`;
    const answer = await post(proxy, batch);
    expect(answer).toMatchObject({ status: 200, text: '[{"jsonrpc":"2.0","id":1,"result":"0x1"}]' });
    expect(node.received.map(({ body }) => body)).toEqual([batch]);
    expect(proxy.requests()).toEqual({});
  });

  it('passes a body that is not JSON on untouched', async () => {
    const node = await startStandIn((_, response) => {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('parse error');
    });
    const proxy = await proxyTo(node.url);
    const answer = await post(proxy, 'not json {');
    expect(answer).toMatchObject({ status: 400, text: 'parse error' });
    expect(node.received.map(({ body }) => body)).toEqual(['not json {']);
  });
});

describe('6. the counts', () => {
  it('counts each method, with and without a method name, faults included', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'rpc-error', code: -32005 } });
    await call(proxy, 'eth_call');
    await call(proxy, 'eth_call');
    await call(proxy, 'eth_chainId');
    expect(proxy.requests('eth_call')).toBe(2);
    expect(proxy.requests('eth_chainId')).toBe(1);
    expect(proxy.requests('eth_getLogs')).toBe(0);
    expect(proxy.requests()).toEqual({ eth_call: 2, eth_chainId: 1 });
  });

  it('returns a record of its own, which a caller cannot change', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    await call(proxy, 'eth_chainId');
    const counts = proxy.requests();
    counts.eth_chainId = 10;
    expect(proxy.requests()).toEqual({ eth_chainId: 1 });
  });

  it('restarts both counts and the call count of result on set()', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    await call(proxy, 'eth_call');
    await call(proxy, 'eth_chainId');
    proxy.set({ eth_call: { fault: { kind: 'result', result: (_, n) => n }, times: 1 } });
    expect(proxy.requests()).toEqual({});
    expect(proxy.requests('eth_call')).toBe(0);
    expect(await resultOf(proxy, 'eth_call')).toBe(1);
    expect(proxy.requests()).toEqual({ eth_call: 1 });
  });

  it('replaces every rule on set()', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: { kind: 'http', status: 429 } });
    proxy.set({ eth_chainId: { kind: 'http', status: 503 } });
    expect(await resultOf(proxy, 'eth_call')).toBe('eth_call#1');
    expect((await post(proxy, request('eth_chainId'))).status).toBe(503);
    proxy.set({});
    expect(await resultOf(proxy, 'eth_chainId')).toBe('eth_chainId#1');
  });

  it('forgets the previous results on set()', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    await call(proxy, 'eth_blockNumber');
    proxy.set({ eth_blockNumber: { kind: 'previous' } });
    expect(await resultOf(proxy, 'eth_blockNumber')).toBe('eth_blockNumber#2');
  });
});

describe('7. node answers that are not JSON', () => {
  const notJson: Respond = ({ body }, response, count) => {
    if (JSON.parse(body).method === 'eth_call') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>gateway</html>');
    } else jsonRpc({ body, method: JSON.parse(body).method }, response, count);
  };

  it.each<[string, Fault]>([
    ['result', { kind: 'result', result: () => '0x1' }],
    ['previous', { kind: 'previous' }],
  ])('under %s are answered with 502, and the proxy keeps serving', async (_, fault) => {
    const node = await startStandIn(notJson);
    const proxy = await proxyTo(node.url);
    proxy.set({ eth_call: fault, eth_chainId: fault });
    expect((await post(proxy, request('eth_call'))).status).toBe(502);
    expect((await post(proxy, request('eth_call'))).status).toBe(502);
    expect((await call(proxy, 'eth_chainId')) as object).toHaveProperty('result');
  });

  it('without a rule are passed on as they are', async () => {
    const node = await startStandIn(notJson);
    const proxy = await proxyTo(node.url);
    expect(await post(proxy, request('eth_call'))).toMatchObject({
      status: 200,
      text: '<html>gateway</html>',
    });
  });

  it('an upstream that refuses the connection is answered with 502, and the proxy keeps serving', async () => {
    const node = await startStandIn();
    const proxy = await proxyTo(node.url);
    await node.stop();
    expect((await post(proxy, request('eth_call'))).status).toBe(502);
    expect((await post(proxy, request('eth_call'))).status).toBe(502);
  });
});

describe('8. stopping and binding', () => {
  it('stop() closes hanging connections', async () => {
    const node = await startStandIn();
    const proxy = await startFaultProxy(node.url);
    proxy.set({ eth_call: { kind: 'hang' } });
    const pending = post(proxy, request('eth_call'));
    pending.catch(() => undefined);
    await delay(50);
    await proxy.stop();
    await expect(pending).rejects.toThrow();
    expect(await canConnect('127.0.0.1', Number(new URL(proxy.url).port))).toBe(false);
  });

  it('a port that cannot be bound rejects', async () => {
    const failure = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
      code: 'EADDRINUSE',
    });
    vi.spyOn(NetServer.prototype, 'listen').mockImplementation(function (this: NetServer) {
      process.nextTick(() => this.emit('error', failure));
      return this;
    });
    await expect(startFaultProxy('http://127.0.0.1:8545')).rejects.toBe(failure);
  });
});
