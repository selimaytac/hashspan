# 0018. A limit on background confirmations

- Status: accepted
- Date: 2026-10-02

## Context

Background confirmation (`confirm: { mode: 'background' }`) and `watch()` poll for a receipt off the caller's path,
for up to `timeoutMs` (default 120 000 ms) each. `@hashspan/cdp` and `@hashspan/x402` confirm through `watch()`. Each
confirmation that is still polling holds a timer, a confirm span and its state, and makes one receipt request per
polling interval. Their number has no bound: an agent that sends transactions faster than they are mined, or
watches many that are never mined, adds requests to its provider and memory to its process for every one of them,
and the provider's rate limits then also slow down the agent's own calls.

## Decision

- `withHashspan()` of `@hashspan/viem` takes `maxBackgroundConfirmations` (default 256): at most that many
  background confirmations, from both `confirm: { mode: 'background' }` and `watch()`, poll at once.
- A confirmation that would exceed the limit is not started: no confirm span is recorded for it, and `watch()` calls
  its `onReceipt` with `undefined` at once. A `diag` warning is logged when the limit is reached, once until the
  count falls below it again.
- Confirmations over the limit are dropped rather than queued: a queue would hold the same state the limit bounds,
  and a confirmation started late would record a later start time than the transaction's. Ending them as `timeout`
  is not used either, since no one waited for them (ADR 0016).
- The caller's own `waitForTransactionReceipt` calls are not counted and always traced: they poll anyway.
- `0` turns background confirmation off; `Infinity` removes the limit. Any other value that is not a number of at
  least 0 uses the default.

## Consequences

- An agent that reaches the limit has send spans without a background confirm span for some transactions; the
  warning says so. Raising the limit, shortening `timeoutMs`, or waiting for receipts in the agent removes the gap.
- The CDP and x402 adapters use the default limit of the `withHashspan()` they create internally.
- Adding the option is a minor change; changing the default later is a behaviour change noted in the changelog.
