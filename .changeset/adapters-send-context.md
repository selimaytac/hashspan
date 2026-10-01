---
'@hashspan/viem': minor
---

`sendTransaction` and `writeContract` now run while their send span is the active span, so spans that wallet, RPC or
HTTP instrumentation creates for the call nest under the send span instead of beside it (ADR 0015). Background
confirmations and the code after the call stay under the caller. Sends of clients without a chain are recorded after
the call and do not nest; with a tracker from `@hashspan/core` before 0.4, the call runs in the caller's context as
before.
