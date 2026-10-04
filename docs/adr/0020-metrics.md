# 0020. Send, confirmation and fee metrics from the tracker

- Status: accepted
- Date: 2026-10-02

## Context

Spans show single transactions. Questions across many of them, such as how long confirmations take per chain, how
often they time out, or what an agent spends on fees, need aggregates that do not depend on keeping every trace.
The tracker already sees every send and confirmation, from every adapter, with its start and end times and fee.

## Decision

- The tracker records three histograms through the OpenTelemetry metrics API, from the meter provider in the new
  `meterProvider` option or the global one: `blockchain.client.send.duration` (`s`),
  `blockchain.client.confirmation.duration` (`s`) and `blockchain.client.fee` (`{wei}`). The names are exported as
  constants, like the attribute keys.
- They are recorded when the matching span ends, with the same start and end times, once per span. The confirmation
  duration is the duration of the confirm span: from the start of the wait, not from the send.
- Attributes are `blockchain.system`, `blockchain.chain.id` and the outcome: `blockchain.tx.status` when it comes from
  chain data, otherwise `error.type`. Addresses, hashes, function names and the agent identity are never metric
  attributes: they would make the number of series unbounded, and agent names can come from Baggage set by a caller.
- Metric names are under `blockchain.client.*`, not the attribute names, so that `blockchain.tx.fee` stays an
  attribute only.
- Bucket boundaries are given as advice and can be replaced by an SDK view.
- Recording never throws; a broken meter provider leaves tracing unchanged.

## Consequences

- Without a metrics SDK, the global meter provider records nothing and costs no more than a no-op call.
- A replaced transaction records two confirmation samples, `replaced` for the awaited hash and the mined
  transaction's outcome for the replacing one; counts of confirmations should leave out `replaced`, as for spans.
- Payments get no metrics yet; amounts in different assets do not add up in one histogram.
- The metric names, units and attributes are a contract like span names, under the change policy in docs/semconv.md.

## Amendment (2026-10-03): attributes added since

- `error.type` on the histograms is kept only when it is an error class name ending in `Error` or a lower-case code of
  letters and underscores; any other value, which could carry an identifier, an address or a number, is recorded as
  `_OTHER` (#177). Spans keep their own `error.type`.
- Samples of user operations carry `blockchain.operation.subject` `user_operation`, and their outcome from chain data
  is `blockchain.user_operation.success` (ADR 0021).

## Amendment (2026-10-04, proposed): who paid a fee

The fee histogram is meant to show what an agent spends, but it also recorded fees the traced account did not pay:
the settlement transaction of a payment, sent and paid for by the facilitator, and user operations a paymaster paid
for (#329). Those samples now carry `blockchain.fee.payer`: `facilitator` or `paymaster`. The attribute is absent when
the sender of the traced transaction or operation paid, as for every sample before, so "what the agent paid" is the
samples without it.

- The samples are kept rather than dropped: a team that pays for its own paymaster, or for a sponsorship plan, still
  sees those costs.
- Values form a closed set; never an address. Only the fee sample carries it: the confirmation duration measures
  observation, not cost.
- The tracker knows a settlement from the payment that linked its hash, and a replacing transaction inherits the
  replaced one's payer (ADR 0008). A settlement confirmed through another tracker, with no link to the payment, is
  recorded as paid by its sender.
