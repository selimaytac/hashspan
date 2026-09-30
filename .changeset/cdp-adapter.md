---
"@hashspan/cdp": minor
---

Add `@hashspan/cdp`: `withHashspan(cdp, { reader })` traces transactions sent by Coinbase CDP server accounts
(`cdp.evm.sendTransaction`, and each account's `sendTransaction`, `transfer`, `swap`, `useSpendPermission` and
network-scoped sends) as `send` spans, and confirms them in the background through a viem `reader`.
