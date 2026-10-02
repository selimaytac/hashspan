---
'@hashspan/cdp': patch
---

A network-scoped account's `waitForTransactionReceipt` without a reader records a flashblocks preconfirmation (a
receipt with a zero or null block hash, such as Base RPCs return before the block is sealed) without
`blockchain.tx.effective_gas_price`, `l1_fee` and `fee`, as ADR 0024 does for `@hashspan/viem`: its fee can be
another transaction's, and without a reader there is no sealed receipt to read. The caller's receipt is unchanged.
