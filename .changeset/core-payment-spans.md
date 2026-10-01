---
'@hashspan/core': minor
---

Add `tracker.startPayment()`, which records a payment that another party settles on chain, such as an x402
facilitator, as a `payment {chainId}` span with the new `blockchain.payment.*` and `x402.*` attributes. A settlement
with a transaction hash links that transaction's confirm span to the payment span (ADR 0013). The settling party's
report never replaces what the payer knew: its payer and amount fill only fields the input left empty, and its hash
does not take over a link the tracker already has. A payment whose
outcome was never learned ends with `timeout()`: `error.type` `timeout` and no `blockchain.payment.status`. The
`paymentResource` option sets how much of the paid resource's URL `x402.resource` records: `origin` (default), `path`
or `off`.
