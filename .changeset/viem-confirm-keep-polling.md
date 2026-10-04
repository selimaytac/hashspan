---
'@hashspan/viem': minor
'@hashspan/cdp': minor
'@hashspan/x402': minor
---

Background confirmation and `watch()` now poll again, one polling interval later, after a failed receipt request (an
HTTP 429, a JSON-RPC error, a request timeout, a connection reset), until their `timeoutMs`, as they already did when
the receipt was not there yet. Before, one failed request ended the confirm span at once with that error, though the
next request would have found the receipt. A provider that keeps failing now ends the span as `timeout`. The
confirmations of `@hashspan/cdp` and `@hashspan/x402` through a `reader` go through `watch()` and behave the same; your
own `waitForTransactionReceipt` calls are unaffected.
