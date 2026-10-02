---
'@hashspan/viem': minor
---

`withHashspan()` traces EIP-5792 call batches (ADR 0022): `sendCalls`, `waitForCallsStatus` and `sendCallsSync` of a
wallet client record `send` and `confirm` spans identified by the batch id. With `experimental_fallback`, the plain
transactions viem sends are linked to the batch's send span and always confirmed as transactions, with their fees.
With a tracker from an older `@hashspan/core`, batches are not traced.
