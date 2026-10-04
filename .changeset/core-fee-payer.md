---
'@hashspan/core': minor
---

`blockchain.client.fee` samples whose fee the traced sender did not pay now carry `blockchain.fee.payer`:
`facilitator` for the settlement transaction of a payment, `paymaster` for a user operation a paymaster paid for.
Samples without it are fees the senders paid, as all samples were counted before; filter on it to chart what an
agent spent. New exports: `ATTR_BLOCKCHAIN_FEE_PAYER`, `BLOCKCHAIN_FEE_PAYER_VALUE_FACILITATOR` and
`BLOCKCHAIN_FEE_PAYER_VALUE_PAYMASTER`.
