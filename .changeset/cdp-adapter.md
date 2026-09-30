---
"@hashspan/cdp": minor
---

Add `@hashspan/cdp`: `withHashspan(cdp, { reader })` traces transactions sent by Coinbase CDP server accounts
(`cdp.evm.sendTransaction`, each account's `sendTransaction`, `transfer`, `swap`, `useSpendPermission` and
network-scoped sends, and `execute()` of swap quotes) as `send` spans, and confirms them in the background through a
viem `reader`. Pass the same `tracker` as to `@hashspan/viem` to share confirm spans with your own receipt waits. Without a reader, a
network-scoped account's `waitForTransactionReceipt` records the confirm span. A failed send
records the CDP API's error type (e.g. `insufficient_balance`) as `error.type`.
