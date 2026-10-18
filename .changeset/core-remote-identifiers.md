---
'@hashspan/core': patch
---

In `hashed` and `off` address mode, identifiers chosen by a remote party are not recorded when they hold an address:
the payment protocol, `x402.scheme`, `mpp.method`, `mpp.intent`, `blockchain.call_batch.id` and the agent id and
name from Baggage are left out when they hold 40 hex characters in a row, with or without `0x`. A payment resource
that still holds them after the address mode is left out, and such an `error.type` is recorded as `_OTHER`. `raw`
mode is unchanged.
