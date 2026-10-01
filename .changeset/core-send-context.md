---
'@hashspan/core': minor
---

`SendHandle.context` is the parent context with the send span set: run the call that sends the transaction in it,
e.g. `await context.with(send.context, () => sendSomehow())`, so that spans of wallet, RPC or HTTP instrumentation
nest under the send span (ADR 0015). When starting the send span fails, it is the parent context.
