---
'@hashspan/cdp': patch
---

A send span of `sendTransaction`, `transfer` or `sendUserOperation` now ends when the SDK call rejects with a value
that cannot be read (a Proxy whose traps throw), as a failure with `error.type` `_OTHER`; before, it stayed open and
was never exported. The rejection still reaches the caller unchanged.
