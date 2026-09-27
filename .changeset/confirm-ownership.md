---
"@hashspan/core": minor
"@hashspan/viem": minor
---

Each transaction now gets one confirm span per tracker. `startConfirm` joins an in-flight confirm span for the same
chain id and hash instead of starting a new one: a receipt from any handle ends it, and a timeout or failure ends it
only when it is the last handle still waiting, so a success is no longer lost when another wait gave up first. After
a receipt, `startConfirm` for that transaction returns a no-op handle for the link TTL; after a timeout or failure, a
retry starts a new span.

The viem adapter no longer deduplicates confirmations itself, so `withHashspan()` results that share a tracker also
share confirm spans. A custom `tracker` now receives a `startConfirm` call for every traced wait and should join them
the same way.
