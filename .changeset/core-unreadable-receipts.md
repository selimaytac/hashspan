---
'@hashspan/core': minor
---

A confirm span ends even when its receipt cannot be read (a throwing Proxy, `null`), with `error.type` `_OTHER`;
before, it stayed open and was never exported. A receipt status other than `success` or `reverted` is no longer
recorded as `success`: the span ends with `error.type` `_OTHER` and no `blockchain.tx.status`.
`CallBatchConfirmHandle.end` no longer throws for a status that cannot be read; the span ends with `error.type`
`_OTHER`.
