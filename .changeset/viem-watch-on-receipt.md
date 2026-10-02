---
'@hashspan/viem': minor
---

`watch()` takes an `onReceipt` callback, called once when the watch ends: with the receipt of the mined transaction,
logs included, or with `undefined` when no receipt was retrieved. It never affects the confirm span; the x402
adapter uses it to check that a settlement transaction carries the payment (ADR 0017).
