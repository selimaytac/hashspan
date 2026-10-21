# @hashspan/faults

## 0.2.0

### Minor Changes

- [#501](https://github.com/selimaytac/hashspan/pull/501) [`cf98a51`](https://github.com/selimaytac/hashspan/commit/cf98a51f673c1a6f767d9ea82cb20ee252154258) Thanks [@selimaytac](https://github.com/selimaytac)! - Add the fault kind `truncate` (ADR 0032): the proxy sends the headers, with a `content-length` larger than what
  follows, and part of the body, then resets the connection, so the client gets those bytes and then a reset, a
  response cut off mid-body. The reset follows a few milliseconds after the bytes were written, which keeps it from
  being lost on a keep-alive connection that has carried many exchanges. Like `reset`, it never reaches the node.

## 0.1.0

### Minor Changes

- [#497](https://github.com/selimaytac/hashspan/pull/497) [`1a2f895`](https://github.com/selimaytac/hashspan/commit/1a2f8954867941b16ce0d98e6ee6953cf5a43f38) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `@hashspan/faults`, a JSON-RPC fault proxy for tests, 0.x while its fault model settles (ADR 0032):
  `startFaultProxy(upstream)` puts an HTTP proxy on a free port of `127.0.0.1` between an EVM client and a local node
  and makes chosen JSON-RPC methods hang, answer with an HTTP status or a JSON-RPC error, reset or drop the connection,
  or answer with a rewritten result or the previous one, with `after` and `times` per rule and `requests()` counts. It
  refuses an upstream that is not loopback unless `allowRemoteUpstream: true`, sends one upstream request per client
  request and never follows a redirect. Node.js 22.3 or later only, no dependencies.
