---
'@hashspan/viem': minor
---

`maxBackgroundConfirmations` (default 256) limits how many background confirmations, from
`confirm: { mode: 'background' }` and `watch()`, poll at once (ADR 0018). A confirmation over the limit is not
started: no confirm span is recorded, `watch()` calls `onReceipt` with `undefined`, and a `diag` warning is logged.
The caller's own waits are not counted.
