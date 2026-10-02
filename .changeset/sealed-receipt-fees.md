---
'@hashspan/viem': patch
---

Confirm spans record fees from the sealed receipt (ADR 0024). On flashblocks RPCs such as Base's, a receipt returned
before its block is sealed (zero block hash) can carry the L1 fee of another transaction; the span now waits, off the
caller's path and for at most 30 s, for the sealed receipt, and records the preconfirmation without
`effective_gas_price`, `l1_fee` and `fee` if it does not come. The caller's receipt is unchanged.
