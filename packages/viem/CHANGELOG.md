# @hashspan/viem

## 0.1.0

### Minor Changes

- [#3](https://github.com/selimaytac/hashspan/pull/3) [`9906585`](https://github.com/selimaytac/hashspan/commit/9906585595be8ac4ae2ac327ffc21affb5a10d11) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `confirm: { mode: 'background' }` to `withHashspan()`: sent transactions are confirmed without an explicit wait
  and without delaying the send. The background confirmation polls independently of the caller's own
  `waitForTransactionReceipt`, whose options (timeout, `confirmations`) are left untouched.

- [#10](https://github.com/selimaytac/hashspan/pull/10) [`09923bd`](https://github.com/selimaytac/hashspan/commit/09923bd42a27ba5ad1417185278ec4670b6d693a) Thanks [@selimaytac](https://github.com/selimaytac)! - Attribute receipts of replaced transactions to the transaction that was mined. `ReceiptLike` accepts optional
  `transactionHash` and `replacementReason`; when the hash differs from the awaited one, the awaited transaction's
  confirm span ends with `blockchain.tx.status = replaced`, `blockchain.tx.replacement.hash` and
  `blockchain.tx.replacement.reason`, and the receipt is recorded on the confirm span of the mined transaction. The
  viem adapter reports replacements from `onReplaced`, keeps the caller's callback and result unchanged, and decodes the
  revert reason of a replacing call to the same contract with the original ABI.

- [#4](https://github.com/selimaytac/hashspan/pull/4) [`de9a101`](https://github.com/selimaytac/hashspan/commit/de9a101b9c293aa83447584b9329359a8134b3e5) Thanks [@selimaytac](https://github.com/selimaytac)! - Record the revert reason of reverted transactions by replaying them on the previous block's state, including custom
  errors for transactions sent with `writeContract`. The replay is bounded (10 s by default,
  `decodeRevertReason: { timeoutMs }`), so an unresponsive provider cannot keep the confirm span open. Opt out with
  `decodeRevertReason: false`.

- [#2](https://github.com/selimaytac/hashspan/pull/2) [`5dc76ea`](https://github.com/selimaytac/hashspan/commit/5dc76ea8d14fe1ae36cb9448ede27a455fee8406) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `withHashspan()`, a viem client extension that traces `sendTransaction` and `writeContract` as `send` spans and
  `waitForTransactionReceipt` as linked `confirm` spans with `@hashspan/core`.
  
  - no telemetry work runs before the traced call: for clients without a chain, the chain id is requested alongside
    the call on every call, so spans follow a wallet that switches networks; a call whose chain id is still unknown
    30 s after it ended is not traced
  - every call into the tracker is guarded, so tracing never changes the result or the error of a traced call
  - `writeContract` arguments are passed to the tracker, which records them with `recordFunctionArguments: true`
  - `flush({ timeoutMs })` on the `withHashspan()` result waits for spans that end after the traced call returned,
    keeps the process alive while waiting and ends whatever it cannot wait for as `timeout`,
    for use before shutting the OpenTelemetry SDK down
  - `diag` logs only error names

### Patch Changes

- Updated dependencies [[`4059847`](https://github.com/selimaytac/hashspan/commit/405984785d2bba6a1887195388d3082b63a3a7e2), [`09923bd`](https://github.com/selimaytac/hashspan/commit/09923bd42a27ba5ad1417185278ec4670b6d693a)]:
  - @hashspan/core@0.1.0
