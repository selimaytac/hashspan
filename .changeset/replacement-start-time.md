---
'@hashspan/core': patch
---

The confirm span of a replacing transaction starts at exactly the start time of the replaced confirm span, read from
the OpenTelemetry SDK span, instead of a wall-clock time taken just after it, which could be up to a few milliseconds
later. With a tracer whose spans do not expose their start time, it starts at that wall-clock time as before. The
`blockchain.client.confirmation.duration` sample of the replacing transaction is measured from the same start as the
replaced one's.
