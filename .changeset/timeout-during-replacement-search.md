---
'@hashspan/viem': patch
---

A wait that times out keeps its timeout when a new wait for the same transaction starts during the replacement search.
Since 1.1.1, after a `waitForTransactionReceipt` timed out, the adapter looks for a replacement viem did not report,
and the timed-out wait's confirm span stayed open while it looked. A retry that started then joined that span, and
its receipt ended it as `success` at the retry's end: the timeout was lost. The retry's confirm span now starts once
the timed-out span has ended, at the time the wait gave up, with `error.type` `timeout`, or as `replaced` when the
search found a replacement. The retry then gets a span of its own, with its own start and outcome, as
docs/semconv.md describes for a retry after a timeout; after a replacement it adds none, as after any receipt. Waits
that started before the timeout still share one span.
