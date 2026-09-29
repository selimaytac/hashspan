# @hashspan/core

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
