---
'@hashspan/viem': patch
---

`watch()`, and background confirmation, no longer poll for a hash that is not a 32-byte hex hash. Such a hash recorded
nothing already, but its poll sent requests until the timeout (120 s by default) in a slot of
`maxBackgroundConfirmations`, and kept `flush()` waiting; `watch()` now calls `onReceipt` with `undefined` at once.
The README lists what differs on viem releases older than 2.33.0 and 2.21.58.
