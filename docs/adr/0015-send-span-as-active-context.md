# 0015. The send span as the active context of the sending call

- Status: accepted
- Date: 2026-10-01

## Context

A send span starts before the call that sends a transaction and ends when its hash is known, but it is not the
active span while that call runs. Spans that wallet, RPC or HTTP instrumentation creates during the call (signing,
`eth_estimateGas`, `eth_sendRawTransaction`, a wallet API request) are therefore siblings of the send span under the
caller's span, not its children. A trace then cannot show what a slow or failed send spent its time on.

## Decision

- **`SendHandle.context`**: the parent context with the send span set. When starting the span fails, it is the
  parent context, so a call run in it still nests under the caller.
- **Adapters run the sending call in it, once**, with `context.with(send.context, call)`. `context.with` is
  synchronous and awaits nothing, so the call starts exactly when it would otherwise (ADR 0009). The call is not
  retried, its result and errors pass through unchanged, and a synchronous throw is recorded once.
- **Only the sending call.** The adapter's own work after the call (ending the span, starting a background
  confirmation) runs in the caller's context, and the link store keeps the send span's parent, so background
  confirmations and the caller's later code stay under the caller, as before. A confirm span started inside the send
  context would become a child of the send span, so no adapter waits for a receipt in it.
- **Trackers from an older core** have no send context. Adapters then run the call in the caller's context, as
  before (ADR 0014).

## Consequences

- With instrumentation of the wallet, the RPC transport or HTTP installed, its spans nest under the send span, which
  changes the exported trace: a minor change for the adapters, noted in their changelogs.
- Sends of a viem client without a chain cannot nest: their send span is recorded after the call, once the chain id
  is known (ADR 0009). Opening the span before the chain id is known and naming it later was rejected, because
  samplers decide on the name and attributes a span starts with.
- x402 payments do not nest the paid request either: the adapter registers hooks and does not wrap the request
  (ADR 0013).
