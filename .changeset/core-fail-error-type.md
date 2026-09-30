---
"@hashspan/core": minor
---

`SendHandle.fail(error, endTime, { errorType })` records a library's machine-readable error code as `error.type` instead
of the error's class name, when it is a short identifier (`[A-Za-z0-9_.-]`, at most 64 characters). `exception.type`
stays the class name.
