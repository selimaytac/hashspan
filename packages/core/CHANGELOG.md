# @hashspan/core

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
