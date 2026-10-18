---
'@hashspan/core': patch
---

In `hashed` and `off` address mode, identifiers chosen by a remote party are not recorded when they hold an address:
the payment protocol, `x402.scheme`, `mpp.method`, `mpp.intent` and the agent id and name from Baggage are left out
when they hold 40 hex characters in a row, with or without `0x`. `blockchain.call_batch.id` is treated like an
address: hashed with the address mode's hash in `hashed` mode, not recorded in `off` mode. A payment resource
that still holds them after the address mode is left out, and such an `error.type` is recorded as `_OTHER`. `raw`
mode is unchanged.
