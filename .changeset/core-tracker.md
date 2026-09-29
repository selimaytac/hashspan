---
"@hashspan/core": minor
---

Add `createTxTracker()`, the transaction lifecycle tracker:

- `send` and `confirm` spans linked by transaction hash, with one confirm span per transaction and tracker: waits
  for the same transaction join the in-flight span, and a receipt from any of them ends it
- receipt status, block, gas, OP-stack L1 fee and total fee; reverted and timed-out transactions set error status
- agent identity from Baggage or a static fallback
- address privacy modes (`raw`, `hashed`, `off`) and a fail-closed redaction hook, which also runs on exception
  attributes
- error messages are kept out of spans by default; `errorMessages` records a sanitized first line or the full
  message and stack trace
- optional `startTime` / `endTime` on every input and handle method, so integrations can record a call after the fact
- instrumentation failures are reported through `diag` and never thrown into the caller
