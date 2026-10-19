---
"@hashspan/viem": minor
---

Rename the JSON-RPC span of a request whose method is not a method name, from `_OTHER` to `jsonrpc`, its `rpc.system.name`, as the OpenTelemetry RPC conventions ask (1.39 and later). `rpc.method` stays `_OTHER`, and the `methods` filter of `traceTransport()` is still called with `_OTHER`. A query or alert on the span name `_OTHER` should filter on `rpc.method` `_OTHER` instead, which matches before and after this release. The semantic conventions schema version is `0.5.0-dev`.
