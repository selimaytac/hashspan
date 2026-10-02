---
'@hashspan/core': minor
---

Add `blockchain.payment.verified` (ADR 0017): `PaymentSettlement.verified` records whether the settlement
transaction's receipt carries the payment, as an adapter checked it from the payer's own data. It is not an error,
and it is kept when the redaction hook fails. `PaymentHandle.link(hash)` links the settling transaction's
confirm span to a payment span that stays open until its receipt is checked.
