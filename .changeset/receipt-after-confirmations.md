---
'@hashspan/viem': minor
---

A traced `waitForTransactionReceipt` with `confirmations` above 1 now records the receipt the chain holds when the
wait resolved, not the one viem read first. After the caller has its result, the confirm span reads the receipt
again, and the block at the receipt's height when that receipt is missing or in another block. When a chain
reorganisation during the wait moved the transaction, the span records the receipt in the new block (block number,
status, gas and fees); when it removed the transaction, the span ends with error status and the new `error.type`
value `not_on_chain`, without `blockchain.tx.status`, and the confirmation duration histogram records that value. A
node without that block, a block that still has the caller's hash, a failed request or an answer that cannot be read
keeps the caller's receipt. The wait returns what viem returned, and the span ends when the wait resolved. Such a
wait makes one more `eth_getTransactionReceipt`, and one `eth_getBlockByNumber` only when the receipt read again is
missing or in another block. Background confirmation, `watch()` and replacements are not affected.
