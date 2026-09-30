---
"@hashspan/viem": patch
---

Background confirmation and `watch()` no longer end the confirm span with `TransactionReceiptNotFoundError` when a
node returns the mined transaction before its receipt: they wait again until their timeout. The result of your own
`waitForTransactionReceipt` calls is unchanged.
