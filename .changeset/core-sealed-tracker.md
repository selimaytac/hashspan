---
'@hashspan/core': minor
---

`TxTracker` and its handles are produced by `createTxTracker()` only and are not meant to be implemented: members
may be added to them in minor releases (ADR 0014). This release adds `startPayment`, so a hand-written tracker no
longer type-checks; use `createTxTracker()` instead, which adapters accept to share one tracker between them.
