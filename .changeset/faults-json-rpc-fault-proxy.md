---
'@hashspan/faults': minor
---

Add `@hashspan/faults`, a JSON-RPC fault proxy for tests, 0.x while its fault model settles (ADR 0032):
`startFaultProxy(upstream)` puts an HTTP proxy on a free port of `127.0.0.1` between an EVM client and a local node
and makes chosen JSON-RPC methods hang, answer with an HTTP status or a JSON-RPC error, reset or drop the connection,
or answer with a rewritten result or the previous one, with `after` and `times` per rule and `requests()` counts. It
refuses an upstream that is not loopback unless `allowRemoteUpstream: true`, sends one upstream request per client
request and never follows a redirect. Node.js 22.3 or later only, no dependencies.
