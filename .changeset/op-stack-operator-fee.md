---
'@hashspan/core': minor
'@hashspan/viem': minor
'@hashspan/cdp': patch
---

Record the OP Stack operator fee (Isthmus and later) as `blockchain.tx.operator_fee`, in wei as a decimal string, on
the confirm span. `ReceiptLike` takes it as `operatorFee`, and `ATTR_BLOCKCHAIN_TX_OPERATOR_FEE` names the attribute.
`blockchain.tx.fee` and the `blockchain.client.fee` histogram keep their meaning and do not include it.

`@hashspan/viem` reads it only for a sealed receipt that carries `operatorFeeScalar` or `operatorFeeConstant`, which
a node adds when the chain charges the fee: one `eth_call` to the GasPriceOracle's `getOperatorFee(gasUsed)` at the
receipt's block, off the caller's path, through the client that read the receipt. Receipts without the fields cost no
request. A failed or malformed answer records the receipt without the operator fee. `@hashspan/cdp` and
`@hashspan/x402` record it when they confirm through a reader.
