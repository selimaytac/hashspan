---
'@hashspan/x402': minor
---

With a reader, a payment span records `blockchain.payment.verified` (ADR 0017): for an `exact` payment authorized
with EIP-3009, `true` when the settlement transaction's receipt carries the token's `AuthorizationUsed` with the
payment's nonce and its `Transfer` from the payer to `payTo` of exactly the amount, `false` when it does not, and no
attribute when no check was possible. The payment span is then exported once the receipt is checked, with its end
time unchanged.
