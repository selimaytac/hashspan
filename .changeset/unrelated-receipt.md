---
'@hashspan/viem': patch
---

A wait that resolves with the receipt of another transaction which viem did not report as a replacement, such as an
endpoint's answer for an unrelated transaction, no longer records that receipt as a replacement: the confirm span
ends with `error.type` `_OTHER` and without the other transaction's block, gas or fee. A replacement viem reports
(same sender and nonce) is recorded as before. The wait still returns what viem returned. This also applies to the
confirmations `@hashspan/cdp` (with a `reader`) and `@hashspan/x402` make through `watch()`.
