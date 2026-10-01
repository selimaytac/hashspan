---
'@hashspan/core': minor
---

A confirm span that gave up waiting, on its own timeout or in `flush()`, no longer records `blockchain.tx.status`
`timeout`, as announced in 0.4.0 (ADR 0016). It keeps error status and `error.type` `timeout`; query that instead.
`blockchain.tx.status` now comes only from chain data (`success`, `reverted`, `replaced`), and the semantic
conventions schema version is `0.2.0-dev`. The deprecated constant `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT` stays
exported until 1.0.
