---
'@hashspan/cdp': patch
---

A network-scoped account's `waitForTransactionReceipt` without a reader now attributes a receipt of another
transaction only to a replacement the SDK's viem client reported through `onReplaced` (same sender and nonce), with
its reason. The adapter adds its own `onReplaced`, which calls yours, and passes `{ transactionHash }` on as
`{ hash, onReplaced }`, the same viem call. A receipt of another hash that viem did not report, such as an endpoint's
answer for an unrelated transaction, is no longer recorded as a replacement: the confirm span ends with `error.type`
`_OTHER`. The wait still returns what the SDK returned.
