---
'@hashspan/viem': patch
---

On Tempo, a fee paid by a transaction of a type other than `0x76`, such as the EIP-1559 (`0x2`) transaction viem
sends on its Tempo chains unless a fee token is named, now records the receipt's `feeToken` as
`blockchain.tx.fee_asset`, and its `blockchain.client.fee` sample carries `blockchain.fee.denomination` `token`.
Before, only a `0x76` receipt was read, so such a fee was recorded as paid in the native currency. A receipt of
another type is read when it also names a `feePayer` that is a valid address, as every Tempo receipt does; the rule
still takes no chain id and imports no chain module. Sponsored fees and pending receipts still come from `0x76`
receipts only.
