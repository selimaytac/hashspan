# 0013. x402 payments as payment spans

- Status: proposed
- Date: 2026-10-01

## Context

[x402](https://www.x402.org) lets an HTTP API ask for payment: it answers `402 Payment Required`, the client signs a
payment and retries, and the server has a facilitator settle it on chain. Agents use it to pay per request for APIs
and paid MCP tools. Relevant facts, from the v2 JavaScript SDK (`@x402/core`, `@x402/fetch`, `@x402/axios`,
`@x402/mcp`, `@x402/evm`, 2.28):

- **The agent does not send a transaction.** For EVM networks, the client only signs an authorization (EIP-3009
  `TransferWithAuthorization` by default, or a Permit2 witness). The facilitator broadcasts it from its own account
  and waits for the receipt, so the transaction's `from` is the facilitator, not the agent.
- **The client reports the outcome.** The paid response carries a `PAYMENT-RESPONSE` header (base64 JSON):
  `success`, `transaction` (the transaction hash for EVM networks), `network`, `payer`, `amount`, `errorReason`.
  `success: true` is returned only after the facilitator saw a successful receipt; `errorReason: settlement_pending`
  means the hash is known but the receipt was not; a failed payment comes back as a 402, not as an error.
- **Networks are CAIP-2 identifiers**, e.g. `eip155:8453`. The SDK's parser for them is not exported.
- **The client has hooks.** `x402Client` runs `onBeforePaymentCreation`, `onAfterPaymentCreation`,
  `onPaymentCreationFailure` and `onPaymentResponse`. `@x402/fetch`, `@x402/axios` and `@x402/mcp` all pay through
  an `x402Client`, so its hooks see every payment. Hooks are awaited without a guard: a hook that throws fails the
  user's request. The payment payload object is the same in the creation and the response hooks.

## Decision

- A new package, `@hashspan/x402`, with `withHashspan(client, options)` for an `x402Client`. Peer dependencies:
  `@x402/core`, `@opentelemetry/api`, and `viem` for the `reader`, as in ADR 0012.
- **Hooks, not wrapping.** It registers hooks on the client: no method is replaced, and the transports need no
  change. Every hook body catches its own failures and logs them via `diag`, and no hook returns a value that alters
  the payment (no abort, no recovery, no retry). A second call on the same client returns the first handle and logs
  a warning.
- **A `payment {chainId}` span, not a `send` span.** It starts before the payment is created and ends when the
  response is processed, inside the caller's context (for example the agent's tool span). A `send` span would claim
  that the agent sent the transaction and record the payer as its sender, which the chain contradicts. The span
  records:
  - `blockchain.operation.name` `payment`, the chain id from the CAIP-2 network, and the payment protocol `x402` and
    scheme;
  - the payer, recipient, asset and amount of the selected payment requirements, with addresses per the address
    mode (ADR 0004);
  - the resource paid for, without query string or fragment, which can carry tokens;
  - the settlement: the transaction hash and a status `settled`, `pending` (`settlement_pending`) or `failed`, with
    the facilitator's `errorReason` as `error.type` when it failed.

  Creating the payment failing, for example a policy or the spend limit refusing it, ends the span as an error with
  no hash. The exact attribute names are added to `docs/semconv.md` with the implementation, under
  `blockchain.payment.*` for protocol-independent fields and `x402.*` for x402's own (scheme, resource).
- **Core support.** The tracker gains `startPayment(input)`, returning a handle that ends with the settlement or a
  failure. A settlement with a hash makes the payment span linkable from a confirm span, as a send span is
  (ADR 0002), so `@hashspan/viem`'s `watch()` links to it.
- **Confirmation only with a reader.** `success: true` already means the facilitator saw a successful receipt, so
  without a `reader` only the payment span is recorded. With a `reader` for the chain, the adapter calls `watch()`
  for every settlement or pending settlement with a hash: the confirm span adds block, gas and fees (paid by the
  facilitator) and resolves pending settlements. `flush()` awaits it (ADR 0010).
- **EVM only, for now.** Payments on networks other than `eip155:*` (Solana, Stellar, ...) are passed through
  untraced, with a `diag` message once per network. Server-side tracing (the resource server's settle hooks) is a
  separate step.
- Tests run offline: a local resource server and facilitator built from the SDK, settling on Anvil with throwaway
  accounts, in the CDP adapter's style.

## Consequences

- An agent's paid API calls appear in its trace with what was paid, to whom and whether it settled, and, with a
  reader, the on-chain confirmation, without claiming a send the agent did not make.
- A new span name and attributes enter the schema; it is still `development` (ADR 0003), so this is a minor change.
- The adapter depends on the hook API of `@x402/core` 2.x, which is public, rather than on object shapes; the
  weekly job of ADR 0012 gains an x402 run against the newest SDK in range.
- Schemes that batch or defer settlement (`upto`, `batch-settlement`) may report no per-request hash; their payment
  spans then end without one, and how to trace their later settlement is left open.
