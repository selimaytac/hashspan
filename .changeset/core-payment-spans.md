---
'@hashspan/core': minor
---

Add `tracker.startPayment()`, which records a payment that another party settles on chain, such as an x402
facilitator, as a `payment {chainId}` span with the new `blockchain.payment.*` and `x402.*` attributes. A settlement
with a transaction hash links that transaction's confirm span to the payment span (ADR 0013). A payment whose
outcome was never learned ends with `timeout()`: `error.type` `timeout` and no `blockchain.payment.status`. The
`paymentResource` option sets how much of the paid resource's URL `x402.resource` records: `origin` (default), `path`
or `off`, at most 512 characters.
