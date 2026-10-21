# @hashspan/faults

A JSON-RPC fault proxy for tests. It sits between an EVM client and a local node, such as Anvil, and makes chosen
JSON-RPC methods hang, fail with an HTTP status or a JSON-RPC error, drop or reset the connection, cut an answer off
mid-body, or answer with a wrong result. The client talks to a real HTTP server, so its own transport, retries and backoff run as they do in
production, which a mocked transport does not show.

It works with any client that speaks JSON-RPC over HTTP: viem, ethers, web3.js, a bundler or a facilitator. It is
the proxy behind the fault tests of [hashspan](https://github.com/selimaytac/hashspan), but does not depend on it.

## Install

```sh
npm install --save-dev @hashspan/faults
```

Node.js only: it is an HTTP server built on `node:http`. Requires Node.js 22.3 or later. No dependencies.

## Usage

```ts
import { startFaultProxy } from '@hashspan/faults';

// In front of a local node, such as Anvil on http://127.0.0.1:8545.
const proxy = await startFaultProxy(nodeUrl);

// The second eth_blockNumber gets a rate limit; the others reach the node.
proxy.set({ eth_blockNumber: { fault: { kind: 'http', status: 429 }, after: 1, times: 1 } });
for (let id = 1; id <= 3; id++) {
  const response = await fetch(proxy.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_blockNumber', params: [] }),
  });
  console.log(response.status, await response.text()); // 200 {"jsonrpc":"2.0","id":1,"result":"0x..."}, 429 ...
}
console.log(proxy.requests()); // { eth_blockNumber: 3 }

await proxy.stop();
```

With viem, pass the proxy's URL to the transport, `http(proxy.url)`: with `retryCount: 0` each fault reaches your code
as it is, and with viem's retries on you test them.

`startFaultProxy(upstream, options?)` resolves to a proxy on a free port of `127.0.0.1`:

| Member | What it does |
|---|---|
| `url` | the proxy's URL, for the client's HTTP transport |
| `set(rules)` | replaces every rule, by JSON-RPC method, and restarts the counts |
| `requests()` | the requests of every method since the last `set()`, as `{ [method]: count }` |
| `requests(method)` | the requests of one method since the last `set()`, faulted ones included |
| `stop()` | closes the proxy and every connection it holds, hanging ones included |

## Faults

| Fault | What the client gets | Reaches the node |
|---|---|---|
| `{ kind: 'hang' }` | no answer; its own timeout ends the request | no |
| `{ kind: 'http', status }` | that HTTP status without a JSON-RPC body, such as 429 | no |
| `{ kind: 'rpc-error', code, message? }` | a JSON-RPC error with the request's id, such as -32005 | no |
| `{ kind: 'reset' }` | a connection reset (TCP RST) before any byte of the answer | no |
| `{ kind: 'drop' }` | the connection closed (TCP FIN) before any byte | no |
| `{ kind: 'truncate' }` | the headers, with a `content-length` larger than what follows, and part of the body, then a connection reset (TCP RST) | no |
| `{ kind: 'result', result }` | the node's result replaced by `result(nodeResult, call)` | once |
| `{ kind: 'previous' }` | the result of this method's previous request, as a load balancer that mixes up answers | once |

`call` counts the method's requests since the last `set()`, from 1, so `result` can return a receipt that stays
`null`, a malformed block or a chain id that changes between calls. Under `result` and `previous`, a node answer that
is not JSON is answered with 502; the proxy keeps serving.

## Rules

A rule is a fault, or `{ fault, after?, times? }`: `after` requests of the method are passed on untouched before the
fault applies (default 0), and it applies to `times` requests (default: all after that). A method can have a list of
rules; the first that applies to a request is used. Every rule counts from the method's first request since the last
`set()`:

```ts
// Request 1 hangs, request 2 fails, request 3 and later reach the node.
proxy.set({
  eth_getTransactionReceipt: [
    { fault: { kind: 'hang' }, times: 1 },
    { fault: { kind: 'rpc-error', code: -32603 }, after: 1, times: 1 },
  ],
});

// No faults.
proxy.set({});
```

Only single JSON-RPC requests are matched. Batches (JSON arrays) and bodies that are not JSON are passed on untouched
and are not counted.

## Safety

The proxy is meant for a node on your own machine:

- It listens on `127.0.0.1` only, on a free port.
- It refuses an upstream that is not loopback: an IPv4 address of `127.0.0.0/8`, `[::1]` or `localhost`, judged
  from the URL as written, without resolving names. Any other host, a compose service name such as `anvil` included,
  needs `startFaultProxy(upstream, { allowRemoteUpstream: true })`. Only `http:` and `https:` upstreams are accepted.
- It sends at most one upstream request per request it receives: no retries, no fan-out and no load features.
- It never follows a redirect: a 3xx answer of the upstream goes back to the client as it is.

`startFaultProxy()` rejects when the upstream is refused or the port cannot be bound. A request the proxy cannot pass
on, such as one to an upstream that is down, is answered with 502.

## Compatibility

This package is 0.x while its fault model settles; a new kind of fault comes in a minor release. The design, with the
faults planned next, is in
[ADR 0032](https://github.com/selimaytac/hashspan/blob/@hashspan/faults@0.2.0/docs/adr/0032-json-rpc-fault-proxy.md).

## License

Apache-2.0
