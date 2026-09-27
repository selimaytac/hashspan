---
"@hashspan/core": minor
"@hashspan/viem": minor
---

Keep telemetry off the call path. `SendInput` and `ConfirmInput` accept an optional `startTime`, and every handle
method an optional trailing `endTime`, so integrations can record a call after the fact. For a viem client without a
chain, the adapter no longer awaits `eth_chainId` before the call: it asks alongside the call, records the span once
the chain id is known (with the call's start and end time), and asks on every call instead of caching the answer, so
spans follow a wallet that switches networks. If the chain id is not available 30 s after the call ended, that call
is not traced.
