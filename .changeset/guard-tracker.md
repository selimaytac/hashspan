---
"@hashspan/viem": patch
"@hashspan/core": patch
---

Never let a tracker change the result of a traced call: every call into the tracker passed to `withHashspan()` and
into its handles is guarded, so a throwing tracker no longer turns a sent transaction into an error, masks the
original send error or causes an unhandled rejection. The core tracker also guards `span.end()`.
