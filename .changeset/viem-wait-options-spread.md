---
'@hashspan/viem': patch
---

`waitForTransactionReceipt` keeps every option when another extension applied before `withHashspan()` copies its
arguments with a spread. Since 0.3.2 only `onReplaced` was an own property of the options the adapter passed on, so
such a copy lost `hash`, `timeout` and `confirmations`.
