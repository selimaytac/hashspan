# 0017. Verify that an x402 settlement transaction carries the payment

- Status: accepted
- Date: 2026-10-02

## Context

With a `reader`, `@hashspan/x402` confirms the transaction hash that the settlement reports (ADR 0013). The confirm
span then shows that transaction's block, gas and fee next to the payment, but nothing checks that the transaction
carries this payment: the hash comes from the server the agent pays.

What the x402 SDK (2.28) settles on chain decides what can be checked:

- **`exact` with EIP-3009** settles one payment per transaction, by `transferWithAuthorization` on the token. Per
  EIP-3009, the token emits `AuthorizationUsed(authorizer, nonce)` with the payment's own nonce, and the transfer
  emits `Transfer(from, to, value)`. The payer knows the nonce, the asset, the recipient and the amount from its own
  payload and the requirements it chose.
- **`exact` with Permit2** and **`upto`** (Permit2 only) settle one payment per transaction through an x402 proxy
  whose events carry no payment identifier; only the token's `Transfer` could be checked.
- **`batch-settlement`** reports no transaction for a request, or one that moves a deposit into an escrow or covers
  many requests: a receipt is not per payment.

The payment span ends when the response is processed, before any receipt exists, and a confirm span belongs to a
transaction, which other spans can share (ADR 0007). A verdict recorded on the confirm span could land on a span that
is not this payment's, such as the confirm span of a transaction the agent sent itself.

## Decision

- **The verdict is `blockchain.payment.verified`, on the payment span.** `true` when the settlement transaction's
  receipt carries this payment, `false` when it does not. It is not an error: the span status is unchanged. It is
  absent when no check was possible: no reader, no receipt (timeout, failure, `flush()` gave up), a reverted
  receipt, or a scheme or authorization method without a check.
- **With a reader, the payment span ends once the check is done**, with its end time set to when the response was
  processed (ADR 0009), so its duration does not change; only its export waits for the confirmation. Without a
  reader, or for a payment without a check, it ends as before. The tracker's new `PaymentHandle.link(hash)` makes the
  settlement transaction's confirm span link to the payment span while it is still open; a tracker without it (an
  older core) gets the previous behaviour (ADR 0014). If `flush()` gives up or too many payments are open, a payment
  waiting for its receipt ends with its settlement and no verdict.
- **The receipt reaches the adapter through `watch()`**: a new `onReceipt` option of `@hashspan/viem`'s `watch()` is
  called once when the watch ends, with the mined transaction's receipt, or without one when none was retrieved. It
  never affects the confirm span or a caller's wait.
- **First check: `exact` with EIP-3009.** The receipt carries the payment when, among its logs from the asset
  (compared without case), it has `AuthorizationUsed(authorizer, nonce)` with the payer and the payload's nonce, and
  `Transfer(from, to, value)` with the payer, the recipient and exactly the amount. Logs are decoded with a fixed
  event ABI owned by the adapter; logs that do not decode are skipped. Every input comes from the payer's own payload
  and requirements, none from the settlement.
- **Later:** Permit2 and `upto`, which can only check the transfer, get a check with a real Permit2 settlement test.
  `batch-settlement` gets none.

## Consequences

- A payment whose reported transaction does not carry it shows `blockchain.payment.verified = false` on its own span,
  whatever other spans that transaction appears in.
- With a reader, payment spans are exported after the confirmation, which `confirmTimeoutMs` and `flush()` bound.
- A token that does not emit `AuthorizationUsed` makes every check `false`; the EIP-3009 standard defines the event,
  and a test against the real USDC on a testnet should confirm it before the check is relied on.
