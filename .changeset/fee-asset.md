---
'@hashspan/core': minor
'@hashspan/viem': minor
---

Name the token a fee was paid in on chains that charge gas in one. The confirm span records
`blockchain.tx.fee_asset`, the token's contract address under the address mode, with the receipt's fee attributes,
and the `blockchain.client.fee` sample carries `blockchain.fee.denomination` `token` (in every address mode). Both
are absent when the fee is in the native currency. Fee values are not converted. `SendInput` and `ReceiptLike` take
the address as `feeAsset`; the receipt's wins, and a replacing transaction never takes the replaced one's.
`ATTR_BLOCKCHAIN_TX_FEE_ASSET`, `ATTR_BLOCKCHAIN_FEE_DENOMINATION` and `BLOCKCHAIN_FEE_DENOMINATION_VALUE_TOKEN` name
them.

`@hashspan/viem` passes Celo's `feeCurrency` from the arguments of `sendTransaction`, `writeContract` and their sync
forms, and Tempo's `feeToken` from a receipt of type `0x76` only, with no extra request. A transaction sent with
`sendRawTransaction`, or confirmed with `watch()` alone, records no Celo fee currency.
