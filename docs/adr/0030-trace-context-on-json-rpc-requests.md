# 0030. W3C trace context on JSON-RPC requests, opt-in

- Status: proposed
- Date: 2026-10-19

## Context

`traceTransport()` (ADR 0019) records each JSON-RPC request as a client span but sends nothing on the wire. A
gateway between the agent and its nodes that reads the W3C `traceparent` header, such as eRPC, can only join its
spans to the agent's trace when the request carries one. OpenTelemetry's undici instrumentation sends it, from a
`POST` span of its own under the JSON-RPC span, so setups without HTTP instrumentation get a separate trace in the
gateway for every request.

`traceTransport()` cannot add the header itself: it wraps the `request` function of a built transport, and viem's
request options carry no headers. viem's `http()` transport has an `onFetchRequest` hook that runs inside the
request, with the JSON-RPC span active. From viem 2.21.25 the hook gets the request init and what it returns is sent;
from 2.21.0 to 2.21.24 it gets the request only and its result is ignored.

The undici instrumentation adds its own `traceparent` header after the hook ran, as a second header line rather than
a replacement. A proxy that joins repeated lines into one value makes eRPC start a new trace for every request. With
`batch: true`, viem groups requests by URL, not by trace, so one HTTP request can carry JSON-RPC requests of
different traces. eRPC reads `traceparent` and `tracestate` and ignores `baggage`.

## Decision

- `@hashspan/viem` exports `propagateTraceContext()`, which returns a hook for viem's
  `http(url, { onFetchRequest })`. Off unless the user passes it; nothing changes for existing setups.
- The hook adds a header only when the active span is a JSON-RPC span of `traceTransport()`: the transport marks the
  context its request runs in. A transport that is not traced, or a method its `methods` option leaves out, gets no
  header, so the hook never sends the context of another span.
- It adds `traceparent` (version `00`, the span's trace id, span id and trace flags, so an unsampled trace stays
  unsampled) and `tracestate` when the span has one, built from the span context. It does not use the global
  propagator, which often includes W3C Baggage: no `baggage` is sent, so baggage entries do not reach a provider.
- A request that already has a `traceparent` header, in any letter case, keeps it. This cannot detect the undici
  instrumentation's header, which is added later, so the docs say to use one or the other, never both.
- An HTTP request with several JSON-RPC requests (`batch: true`) gets no header: the hook sees the context of the
  request that started the batch, and sending it would put the other requests, possibly of other traces, in that
  trace. A batch of one request gets its header.
- Below viem 2.21.25 the hook adds nothing and logs one `diag` warning; the peer range stays `^2.21.0`.
- The hook never throws: on a failure it logs through `diag` and the request is sent unchanged.

## Consequences

- With the hook and no HTTP instrumentation, a gateway's server span sits directly under the JSON-RPC span, with no
  extra `POST` span, so a span-metrics generator counts one client span per request.
- The trace id, span id and sampled flag of each request reach the provider, as with any HTTP instrumentation that
  propagates W3C trace context. The gateway decides what to record: eRPC at `sampleRate: 1` records every request,
  whatever the flag says.
- Batched requests are not joined to the trace. A later option could send a header for batches whose requests all
  share one trace.
- A user's own `onFetchRequest` hook can call this one and return its result.
