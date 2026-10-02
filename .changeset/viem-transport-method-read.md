---
'@hashspan/viem': patch
---

`traceTransport()` reads a request's `method` only from an own data property, as the other traced actions read
their arguments: a request whose `method` is an accessor, or whose properties cannot be read, is sent untraced, and
no getter of the caller's runs an extra time.
