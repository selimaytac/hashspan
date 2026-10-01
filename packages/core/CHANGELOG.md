# @hashspan/core

## 0.5.0

### Minor Changes

- [#127](https://github.com/selimaytac/hashspan/pull/127) [`2c2ddb6`](https://github.com/selimaytac/hashspan/commit/2c2ddb61321580b0dcca205faef5e9a6a15ca43b) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `blockchain.payment.settled_amount`: the amount the settling party reports it settled, recorded as reported next
  to `blockchain.payment.amount`, which keeps the amount the payer knew. With x402's `upto` scheme, it shows what was
  actually charged when that is less than the authorized maximum.

- [#120](https://github.com/selimaytac/hashspan/pull/120) [`7ca4af6`](https://github.com/selimaytac/hashspan/commit/7ca4af6541f09ede2e328cd15eaee2e530a6a48c) Thanks [@selimaytac](https://github.com/selimaytac)! - A confirm span that gave up waiting, on its own timeout or in `flush()`, no longer records `blockchain.tx.status`
  `timeout`, as announced in 0.4.0 (ADR 0016). It keeps error status and `error.type` `timeout`; query that instead.
  `blockchain.tx.status` now comes only from chain data (`success`, `reverted`, `replaced`), and the semantic
  conventions schema version is `0.2.0-dev`. The deprecated constant `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT` stays
  exported until 1.0.

## 0.4.0

### Minor Changes

- [#107](https://github.com/selimaytac/hashspan/pull/107) [`c20d91d`](https://github.com/selimaytac/hashspan/commit/c20d91da7ec552fc9d6a6d50c62b8eb4b3a2412f) Thanks [@selimaytac](https://github.com/selimaytac)! - Deprecate the value `timeout` of `blockchain.tx.status` and the constant `BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT`
  (ADR 0016). `blockchain.tx.status` describes the transaction as the chain recorded it; a confirm span that gave up
  waiting already records error status and `error.type` `timeout`, so query that instead. The value is still recorded
  in this release and stops being recorded in the next minor release; the constant is removed in 1.0.

- [#94](https://github.com/selimaytac/hashspan/pull/94) [`15f16ba`](https://github.com/selimaytac/hashspan/commit/15f16bac79dc5dc13506a224fdea9c4abf5d0a34) Thanks [@selimaytac](https://github.com/selimaytac)! - Handle methods take an options object: `send.end({ hash }, { endTime })`, `send.fail(error, { endTime, errorType })`,
  `confirm.end(receipt, { endTime })`, `confirm.timeout({ endTime })` and `confirm.fail(error, { endTime })` (ADR 0014).
  The positional forms still work and are deprecated until 1.0: `send.end(hash, endTime)`,
  `send.fail(error, endTime, { errorType })`, `confirm.end(receipt, endTime)`, `confirm.timeout(endTime)` and
  `confirm.fail(error, endTime)`. An end time that is not a `Date`, an `HrTime` or a finite number is ignored.

- [#92](https://github.com/selimaytac/hashspan/pull/92) [`990a2ea`](https://github.com/selimaytac/hashspan/commit/990a2ea75536f6451923bbb51d1f4684aee48b3d) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `tracker.startPayment()`, which records a payment that another party settles on chain, such as an x402
  facilitator, as a `payment {chainId}` span with the new `blockchain.payment.*` and `x402.*` attributes. A settlement
  with a transaction hash links that transaction's confirm span to the payment span (ADR 0013). The settling party's
  report never replaces what the payer knew: its payer and amount fill only fields the input left empty, and its hash
  does not take over a link the tracker already has. A payment whose
  outcome was never learned ends with `timeout()`: `error.type` `timeout` and no `blockchain.payment.status`. The
  `paymentResource` option sets how much of the paid resource's URL `x402.resource` records: `origin` (default), `path`
  or `off`, at most 512 characters.

- [#93](https://github.com/selimaytac/hashspan/pull/93) [`2f424f2`](https://github.com/selimaytac/hashspan/commit/2f424f2896d66d7d6b32e448b5643c81f0bee1a2) Thanks [@selimaytac](https://github.com/selimaytac)! - `TxTracker` and its handles are produced by `createTxTracker()` only and are not meant to be implemented: members
  may be added to them in minor releases (ADR 0014). This release adds `startPayment` to the tracker and `context` to
  the send handle, so a hand-written tracker no longer type-checks; use `createTxTracker()` instead, which adapters
  accept to share one tracker between them.

- [#103](https://github.com/selimaytac/hashspan/pull/103) [`905d2f8`](https://github.com/selimaytac/hashspan/commit/905d2f859b1130657ab92d11dcb90bae86e7517e) Thanks [@selimaytac](https://github.com/selimaytac)! - `SendHandle.context` is the parent context with the send span set: run the call that sends the transaction in it,
  e.g. `await context.with(send.context, () => sendSomehow())`, so that spans of wallet, RPC or HTTP instrumentation
  nest under the send span (ADR 0015). When starting the send span fails, it is the parent context.

## 0.3.0

### Minor Changes

- [#67](https://github.com/selimaytac/hashspan/pull/67) [`28a83c2`](https://github.com/selimaytac/hashspan/commit/28a83c265f11836a5eca26a99971daa402abc4d3) Thanks [@selimaytac](https://github.com/selimaytac)! - `SendHandle.fail(error, endTime, { errorType })` records a library's machine-readable error code as `error.type` instead
  of the error's class name, when it is a short identifier (`[A-Za-z0-9_.-]`, at most 64 characters). `exception.type`
  stays the class name.

## 0.2.0

### Minor Changes

- [#50](https://github.com/selimaytac/hashspan/pull/50) [`6da02c7`](https://github.com/selimaytac/hashspan/commit/6da02c74d872a05e04f496cc10fcc9a04fb43c6c) Thanks [@selimaytac](https://github.com/selimaytac)! - A field set in the static `agent` option now always wins over the Baggage entries `gen_ai.agent.id` /
  `gen_ai.agent.name`; Baggage only fills fields the option leaves unset. The new `agentFromBaggage: false` option stops
  reading agent identity from Baggage, for services that accept requests from outside their trust boundary, where a
  caller could otherwise attribute transactions to another agent.

- [#45](https://github.com/selimaytac/hashspan/pull/45) [`7dc19d1`](https://github.com/selimaytac/hashspan/commit/7dc19d16f72e0c1ed8308ecfa006afacc3989c48) Thanks [@selimaytac](https://github.com/selimaytac)! - Require Node.js 22.3 or later (`engines`). Node.js 18 and 20 have reached end of life, and `hashed` address mode relies
  on `process.getBuiltinModule`, available from Node.js 22.3; the packages are built for that target.

## 0.1.0

### Minor Changes

- [#1](https://github.com/selimaytac/hashspan/pull/1) [`4059847`](https://github.com/selimaytac/hashspan/commit/405984785d2bba6a1887195388d3082b63a3a7e2) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `createTxTracker()`, the transaction lifecycle tracker:
  
  - `send` and `confirm` spans linked by transaction hash, with one confirm span per transaction and tracker: waits
    for the same transaction join the in-flight span, and a receipt from any of them ends it
  - receipt status, block, gas, OP-stack L1 fee and total fee; reverted and timed-out transactions set error status
  - agent identity from Baggage or a static fallback
  - address privacy modes (`raw`, `hashed`, `off`) and a fail-closed redaction hook, which also runs on exception
    attributes
  - decoded call arguments are recorded only with `recordFunctionArguments`, as a JSON array with addresses per
    address mode, without calling `toJSON()` or getters
  - in `hashed` and `off` mode, hex values longer than an address are recorded as `<hex>`, so a padded or
    ABI-encoded address cannot leak through arguments, revert reasons or error messages
  - error messages are kept out of spans by default; `errorMessages` records a sanitized first line or the full
    message and stack trace
  - optional `startTime` / `endTime` on every input and handle method, so integrations can record a call after the fact
  - instrumentation failures are reported through `diag` and never thrown into the caller

- [#10](https://github.com/selimaytac/hashspan/pull/10) [`09923bd`](https://github.com/selimaytac/hashspan/commit/09923bd42a27ba5ad1417185278ec4670b6d693a) Thanks [@selimaytac](https://github.com/selimaytac)! - Attribute receipts of replaced transactions to the transaction that was mined. `ReceiptLike` accepts optional
  `transactionHash` and `replacementReason`; when the hash differs from the awaited one, the awaited transaction's
  confirm span ends with `blockchain.tx.status = replaced`, `blockchain.tx.replacement.hash` and
  `blockchain.tx.replacement.reason`, and the receipt is recorded on the confirm span of the mined transaction. The
  viem adapter reports replacements from `onReplaced`, keeps the caller's callback and result unchanged, and decodes the
  revert reason of a replacing call to the same contract with the original ABI.
