---
'@hashspan/core': minor
---

Add `blockchain.payment.settled_amount`: the amount the settling party reports it settled, recorded as reported next
to `blockchain.payment.amount`, which keeps the amount the payer knew. With x402's `upto` scheme, it shows what was
actually charged when that is less than the authorized maximum.
