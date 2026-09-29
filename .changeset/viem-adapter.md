---
"@hashspan/viem": minor
---

Add `withHashspan()`, a viem client extension that traces `sendTransaction` and `writeContract` as `send` spans and
`waitForTransactionReceipt` as linked `confirm` spans with `@hashspan/core`.

- no telemetry work runs before the traced call: for clients without a chain, the chain id is requested alongside
  the call on every call, so spans follow a wallet that switches networks; a call whose chain id is still unknown
  30 s after it ended is not traced
- every call into the tracker is guarded, so tracing never changes the result or the error of a traced call
- `diag` logs only error names
