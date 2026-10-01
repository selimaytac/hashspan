---
"@hashspan/viem": patch
---

`watch()` records nothing, with a `diag` warning, when its `chainId` option contradicts the chain of the client it
was given, instead of polling that client and ending the confirm span as a timeout for the wrong chain.
