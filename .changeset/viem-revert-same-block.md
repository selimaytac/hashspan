---
'@hashspan/viem': patch
---

The revert reason of a transaction that calls a contract created earlier in the same block is now recorded: when the
replay on the previous block does not revert (the contract has no code there yet), the transaction is replayed once
more on its own block (ADR 0005 amendment). It costs one more `eth_call`, only in that case.
