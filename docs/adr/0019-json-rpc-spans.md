# 0019. JSON-RPC spans from a viem transport

- Status: proposed
- Date: 2026-10-02

## Context

A send span covers the whole sending call: the wallet's nonce and fee lookups, signing and the broadcast. When a
send is slow or fails, the span does not show which request to the provider took the time or returned the error.
Since ADR 0015 the sending call runs with the send span active, so spans that the transport creates nest under it.
viem has no tracing of its own, and OpenTelemetry's HTTP instrumentations record a `POST` per request without the
JSON-RPC method.

## Decision

- `@hashspan/viem` exports `traceTransport(transport, options?)`, which wraps any viem transport. Each request it
  sends becomes a `CLIENT` span named after the JSON-RPC method, following the OpenTelemetry RPC conventions
  (semantic conventions 1.43): `rpc.system.name` `jsonrpc`, `rpc.method`, `jsonrpc.protocol.version` `2.0`, and
  `server.address` and `server.port` from the transport's URL when it has one. `blockchain.chain.id` is added when
  the client has a chain. A method name that is not one (letters, digits and `_`, up to 64) is recorded as `_OTHER`.
- Nothing else of a request is recorded: no parameters, no results, and of the URL only the host and port, since
  the path or query often carries an API key. A failed request ends with error status and `error.type`: its
  JSON-RPC error code when it has one, also recorded as `rpc.response.status_code`, else the error's class name. The
  error message is not recorded (ADR 0006).
- The request runs with its span active, so an HTTP instrumentation's spans nest under it.
- `options.methods` selects the methods that get a span, for example to leave out receipt polling; `tracerProvider`
  replaces the global provider.
- It is separate from `withHashspan()`: a transport is set up before the client, and the spans are useful without
  transaction tracing. Tracing never changes a request, its result or its error; if the transport cannot be
  traced, it is returned as created.

## Consequences

- With `traceTransport()` and `withHashspan()` together, a trace shows the provider requests of each send and
  receipt wait under their spans.
- Receipt polling adds one span per polling interval; `methods` leaves it out.
- The RPC conventions are still experimental in OpenTelemetry; if they change, the attribute names follow them
  with a deprecation period, as for any span contract here.
