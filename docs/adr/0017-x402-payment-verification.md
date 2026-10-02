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
- **Then:** Permit2 and `upto`, which can only check the transfer, get a check with a real Permit2 settlement test
  (see *Amendment: Permit2 and `upto`*). `batch-settlement` gets none.

## Consequences

- A payment whose reported transaction does not carry it shows `blockchain.payment.verified = false` on its own span,
  whatever other spans that transaction appears in.
- With a reader, payment spans are exported after the confirmation, which `confirmTimeoutMs` and `flush()` bound.
- A token that does not emit `AuthorizationUsed` makes every check `false`; the EIP-3009 standard defines the event,
  and a test against the real USDC on a testnet should confirm it before the check is relied on.

## Amendment: Permit2 and `upto`

- Date: 2026-10-02

### Context

With `extra.assetTransferMethod: 'permit2'`, the payer signs a Permit2 `PermitWitnessTransferFrom` (the payload's
`permit2Authorization`: `from`, `permitted.token` and `permitted.amount`, `spender`, `nonce`, `deadline` and a
`witness` with the recipient `to`) for an x402 proxy as spender. The facilitator calls the proxy, which has Permit2
transfer the tokens. A real settlement receipt (SDK 2.28, settled on Anvil with the contracts copied from Base
Sepolia) has the token's `Transfer(payer, payTo, value)` and then the proxy's `Settled()`. With EIP-2612 gas
sponsoring, the receipt has the token's `Approval` and `Transfer` and the proxy's `SettledWithPermit()` instead, per
the proxy's code; that path is not settled in a test. Permit2 emits nothing, and no log carries the nonce.

`upto` is Permit2 only, through its own proxy. Its witness also names the `facilitator`, the only sender the proxy
accepts. The server settles any amount up to `permitted.amount`, chosen at settlement time; the settlement reports it
as `amount`.

### Decision

- **`exact` with Permit2:** the check applies when the scheme is `exact` and the payload has `permit2Authorization`.
  Its inputs come from the payer's own payload and requirements: the asset (`requirements.asset`, which must equal
  `permitted.token`), the payer (`from`), the recipient (`requirements.payTo`, which must equal `witness.to`), the
  amount (`requirements.amount`, which must equal `permitted.amount`) and the proxy (`spender`). A mismatch or a
  malformed value means no check. The receipt carries the payment when the transaction was sent to the proxy, the
  proxy emitted `Settled()` or `SettledWithPermit()`, and the asset emitted `Transfer` from the payer to the recipient
  of exactly the amount.
- **`upto`:** the same inputs, with the maximum (`permitted.amount`) for the amount and the facilitator
  (`witness.facilitator`, which must be an address). The receipt carries the payment when the transaction was sent by
  the facilitator to the proxy, the proxy emitted one of its events, and the asset emitted `Transfer` from the payer to
  the recipient of more than nothing, at most the maximum and, when the settlement reported an amount, exactly that
  amount. A settlement of nothing reports no transaction and gets no verdict.
- As for EIP-3009, addresses are compared without case, logs are decoded with fixed event ABIs owned by the adapter,
  logs that do not decode are skipped, and a reverted receipt gets no verdict.
- **Reuse of a transaction:** no log identifies the payment, so a server could report the transaction of an identical
  earlier payment (same payer, recipient, asset and amount). Superseded by *Amendment: the Permit2 nonce*, which
  replaces an in-memory list of verified transactions with the nonce in the transaction's input.

### Consequences

- A facilitator that settles through another contract, such as a batching or multicall contract, sends a transaction
  whose `to` is not the proxy: its genuine settlements get `false`. The SDK's facilitators call the proxy directly.
- The settlement test runs the deployed Permit2 and proxies on Anvil, from code copied from Base Sepolia
  (`packages/x402/test/permit2/`), so a change of those contracts needs the copies refreshed by hand.

## Amendment: the Permit2 nonce

- Date: 2026-10-02

### Context

No log of a Permit2 settlement carries the payment's nonce, but the transaction's input does: both x402 proxies take
the Permit2 permit (`permitted`, `nonce`, `deadline`) and its `owner` as arguments of `settle` and `settleWithPermit`
(the same in SDK 2.13 and 2.28). Permit2 uses a nonce of an owner once, so a successful settlement with the payer's
nonce is this payment and no other.

### Decision

- For an `exact` Permit2 or `upto` payment whose receipt carries it by the rules above, the adapter reads the
  transaction (`eth_getTransactionByHash`) through the reader and decodes its input with fixed ABIs of the proxies'
  settlement functions, owned by the adapter (the exact proxy's for `exact`, the upto proxy's for `upto`). The payment
  is verified when the decoded permit's `nonce` equals the payload's `permit2Authorization.nonce` and its `owner` is
  the payer.
- Input that does not decode as one of those functions, or with another nonce or owner, is `false`.
- A transaction that cannot be read within 10 seconds, or a failed request, means no verdict. The payment span stays
  open until then; `flush()` ends it without a verdict if it cannot wait longer.
- A receipt that does not carry the payment is `false` without reading the transaction.
- The in-memory list of verified transactions is removed: the nonce check covers other processes, other
  `withHashspan()` calls and restarts.
- A payload whose nonce is not a decimal string means no check, like the other malformed values.

### Consequences

- One more request through the reader per Permit2 settlement that the receipt check accepts, off the call path
  (ADR 0009).
- A proxy whose settlement functions change would make genuine settlements `false` until the ABIs are updated; the
  unit tests encode inputs with the SDK's own proxy ABIs, so the weekly runs against the SDK peer range catch a change.
