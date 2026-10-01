# 0009. Telemetry off the call path

- Status: accepted
- Date: 2026-09-28
- Clarified: 2026-09-29: "telemetry work" means work that is awaited. When everything a span needs is known up
  front, the adapter starts the span synchronously as the call starts, as before; it never awaits anything first.

## Context

A span needs facts that are not always known when the instrumented call starts. The viem adapter needs the chain
id for the span name, `blockchain.chain.id`, send-to-confirm links and confirm deduplication (ADR 0007). For a
client without a configured chain it asked the node (`eth_chainId`) and awaited the answer before calling
`sendTransaction` or `waitForTransactionReceipt`, so a slow or unresponsive node delayed the user's call, and an
`eth_chainId` that never answered blocked it. The answer was also cached per client, so after a wallet switched
networks, later spans carried the old chain id.

Future adapters will face the same shape: facts that arrive after the call started (a settlement id, a provider's
transaction hash).

## Decision

**Adapters never do telemetry work before the call they instrument.** Anything the span needs that is not known
synchronously is resolved concurrently with the call, and the span is recorded once it is known.

**Explicit times in the core API.** `SendInput` and `ConfirmInput` accept an optional `startTime`, and every handle
method accepts an optional trailing `endTime`. An adapter that records late captures the parent context and the
start time when the call starts, the end time when it settles, and records the span with both. Only spans recorded
this way get explicit times: with an explicit start time, the OpenTelemetry SDK measures the span by the wall clock
(millisecond precision) instead of the monotonic clock, so spans whose facts are known up front keep the default
timing. For a joined confirm span (ADR 0007) the first handle's start time applies and the handle that ends the span
supplies the end time.

**viem adapter.**

- Clients with a chain (on the client or in the call) are traced as before.
- For a client without a chain, the adapter captures the active context and the start time, starts the chain id
  request and the user's call together, and returns the user's promise unchanged. The span is recorded with
  `context.with` on the captured context, so the core's parent rules and Baggage apply as if it had been started
  at the call.
- The chain id is not cached; concurrent calls share one request. This costs one `eth_chainId` per traced call for
  clients without a chain, off the call path.
- If the chain id request fails, or has not answered 30 seconds after the call settled, the telemetry of that call
  is dropped and the error name is logged through `diag`. The timer does not keep the process alive.
- `onReplaced` is always wrapped, so replacements are attributed (ADR 0008) however late the span is recorded.

## Consequences

- A slow or failing node cannot delay or fail a traced call through the adapter's own requests.
- Spans of clients without a chain have millisecond precision and may be exported a little after the call ended.
- If both the sending and the waiting client lack a chain and the wait's chain id answers before the send's, the
  confirm span can miss its link to the send span.
- Custom trackers receive the extra arguments; implementations that ignore them keep working.
- Amended by [ADR 0014](0014-core-api-boundary.md): the end time moves into an options object, `{ endTime }`; the
  trailing positional form is deprecated until 1.0.
