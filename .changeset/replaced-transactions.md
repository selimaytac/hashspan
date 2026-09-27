---
"@hashspan/core": minor
"@hashspan/viem": minor
---

Attribute receipts of replaced transactions to the transaction that was mined. `ReceiptLike` gains optional
`transactionHash` and `replacementReason`; when the hash differs from the awaited one, the tracker ends the awaited
transaction's confirm span with `blockchain.tx.status = replaced`, `blockchain.tx.replacement.hash` and
`blockchain.tx.replacement.reason`, and records the receipt on the confirm span of the mined transaction. The viem
adapter reports replacements from `onReplaced`, keeps the caller's callback and result unchanged, and decodes the
revert reason of a replacing call to the same contract with the original ABI.
