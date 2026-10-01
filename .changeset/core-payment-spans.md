---
'@hashspan/core': minor
---

Add `tracker.startPayment()`, which records a payment that another party settles on chain, such as an x402
facilitator, as a `payment {chainId}` span with the new `blockchain.payment.*` and `x402.*` attributes. A settlement
with a transaction hash links that transaction's confirm span to the payment span (ADR 0013).
