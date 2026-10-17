---
'@hashspan/x402': patch
---

Payments with x402's `batch-settlement` scheme no longer record the channel's deposit as their settlement. The
response to the request that opens a channel reports the deposit into escrow as its `transaction` and `amount`; that
payment span recorded the deposit as `blockchain.payment.settled_amount` and as `blockchain.tx.hash`, and the
deposit's confirm span linked to it. A `batch-settlement` payment span now records the request's charge
(`extra.chargedAmount`, which can be less than the price) as `blockchain.payment.settled_amount`, and no transaction:
no hash, no confirm span through the reader and no `blockchain.payment.verified`. The README says what `settled`
means for this scheme, and that the deposit, claim, settle and refund transactions are sent on the server side.
