---
"@hashspan/viem": minor
---

Add `watch(client, { hash, chainId?, timeoutMs?, abi? })` to the `withHashspan()` result: it confirms a transaction
sent outside the extended clients, such as by a wallet API, in the background, with the receipt, revert reason and
fees, linked to a send span recorded by the same tracker.
