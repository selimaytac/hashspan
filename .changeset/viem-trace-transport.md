---
'@hashspan/viem': minor
---

`traceTransport(transport, options?)` wraps a viem transport so that each JSON-RPC request becomes a client span
named after its method, with the OpenTelemetry RPC attributes, the server's host and port and the chain id, and no
parameters, results or URL path (ADR 0019). With `withHashspan()`, the requests of a transaction nest under its send
span. `methods` selects the methods to trace.
