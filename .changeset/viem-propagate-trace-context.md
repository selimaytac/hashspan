---
"@hashspan/viem": minor
---

Add `propagateTraceContext()`, an opt-in `onFetchRequest` hook for viem's `http()` transport: each request sends the W3C `traceparent` (and `tracestate`) of its JSON-RPC span from `traceTransport()`, so an RPC gateway such as eRPC records its spans in the same trace without HTTP instrumentation. It never sends `baggage`, keeps a `traceparent` the request already has, and sends none for an HTTP request of several batched JSON-RPC requests. Needs viem 2.21.25 or later. Use it or an HTTP instrumentation such as undici's, not both.
