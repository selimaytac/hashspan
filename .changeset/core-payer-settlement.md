---
'@hashspan/core': minor
---

Record payments whose settlement transaction the payer sends or signs itself, as with MPP (ADR 0029):
`PaymentInput` gains `sender` (`'payer'` labels the settlement's fee `sponsor` only when the receipt names another
fee payer, never `facilitator`), `hash` (the settlement's hash when the payer knows it first: recorded as
`blockchain.tx.hash` from the span's start, so a timeout keeps it, never replaced by a reported one, and linked to
the tracker's own send span of it) and `mpp` (`mpp.method`, `mpp.intent`, `mpp.mode`, `mpp.challenge.id` and
`mpp.resource`). `blockchain.payment.protocol` gains the value `mpp`. `TxTracker.paymentSenders` tells an adapter
that the tracker reads the new fields.
