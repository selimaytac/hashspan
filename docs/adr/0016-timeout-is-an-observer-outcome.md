# 0016. A timeout is an outcome of the observer, not of the transaction

- Status: accepted
- Date: 2026-10-01

## Context

`blockchain.tx.status` takes the values `success` and `reverted` from a receipt, `replaced` from the receipt of
another transaction (ADR 0008), and `timeout` when the tracker gave up waiting for a receipt, on its own timeout or
when `flush()` gave up (ADR 0010). The first three describe the transaction, as the chain recorded it; `timeout`
describes the observer. A transaction whose confirm span ended as `timeout` is often mined a moment later, and a
dashboard grouping transactions by `blockchain.tx.status` counts it as a fourth outcome that it never had. Once
dashboards depend on the value after 1.0, removing it would be a major change.

The confirm span already records the observer's outcome the OpenTelemetry way: error status and `error.type`
`timeout`. Payment spans follow that rule from the start: `blockchain.payment.status` comes only from the settling
party, and a payment whose outcome was never learned has no status and `error.type` `timeout` (ADR 0013).

## Decision

- `blockchain.tx.status` is set only from chain data: `success`, `reverted` or `replaced`. Without it, the outcome
  is unknown.
- A confirm span that gave up waiting, on its own timeout or in `flush()`, ends with error status and `error.type`
  `timeout`, as today.
- The value `timeout` of `blockchain.tx.status` is deprecated now, while it is still emitted, and stops being
  emitted in the first minor release after the one that announced the deprecation. The constant
  `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT` stays exported, deprecated, until 1.0. The schema version is bumped when the
  value stops being emitted.

## Consequences

- Queries and alerts on `blockchain.tx.status = timeout` should use `error.type = timeout` on confirm spans; both
  are recorded during the deprecation.
- A transaction counted by `blockchain.tx.status` has a known on-chain outcome.
- Distinguishing a confirm timeout from a flush that gave up is out of scope; both are `timeout`.

## Amendment (2026-10-03): implemented

The value `timeout` of `blockchain.tx.status` is no longer emitted since `@hashspan/core` 0.5.0 (#120), with the
schema version `0.2.0-dev`; the deprecated constant stays exported until 1.0.
