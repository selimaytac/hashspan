---
'@hashspan/core': patch
---

A receipt without a readable block number or gas used, such as what viem returns when a node answers with something
that is not a receipt, now ends the confirm span with error status and `error.type` `_OTHER`, records one confirmation
sample, and lets a later wait record the receipt, as docs/semconv.md describes. Before, the span ended with no outcome
and no error, and no confirmation sample was recorded.
