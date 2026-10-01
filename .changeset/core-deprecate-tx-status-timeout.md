---
'@hashspan/core': minor
---

Deprecate the value `timeout` of `blockchain.tx.status` and the constant `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT`
(ADR 0016). `blockchain.tx.status` describes the transaction as the chain recorded it; a confirm span that gave up
waiting already records error status and `error.type` `timeout`, so query that instead. The value is still recorded
in this release and stops being recorded in the next minor release; the constant is removed in 1.0.
