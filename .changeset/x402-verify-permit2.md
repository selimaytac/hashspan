---
'@hashspan/x402': minor
---

With a reader, `blockchain.payment.verified` is also recorded for Permit2 payments (ADR 0017): for an `exact`
payment, `true` when the settlement transaction was sent to the x402 proxy the payer authorized, the proxy emitted its
settlement event and the token emitted `Transfer` from the payer to `payTo` of exactly the amount; for `upto`, when
the transaction was also sent by the facilitator the authorization names, and the transfer is of more than nothing, at
most the authorized maximum and, when the settlement reports an amount, exactly that amount. Since no log carries the
payment's nonce, a settlement transaction already verified for an earlier Permit2 payment of the same `withHashspan()`
(among the last 1000) is `false` for a later one.
