# @hashspan/cdp

## 0.5.0

### Patch Changes

- Updated dependencies [[`2c2ddb6`](https://github.com/selimaytac/hashspan/commit/2c2ddb61321580b0dcca205faef5e9a6a15ca43b), [`7ca4af6`](https://github.com/selimaytac/hashspan/commit/7ca4af6541f09ede2e328cd15eaee2e530a6a48c)]:
  - @hashspan/core@0.5.0
  - @hashspan/viem@0.5.0

## 0.4.0

### Minor Changes

- [#110](https://github.com/selimaytac/hashspan/pull/110) [`0707134`](https://github.com/selimaytac/hashspan/commit/0707134283d1c6fd6024e675855813627f8e42ca) Thanks [@selimaytac](https://github.com/selimaytac)! - Traced CDP calls now run while their send span is the active span, so spans that HTTP instrumentation creates for the
  CDP API request nest under the send span instead of beside it (ADR 0015). Background confirmations and the code after
  the call stay under the caller; with a tracker from `@hashspan/core` before 0.4, the call runs in the caller's context
  as before.

### Patch Changes

- Updated dependencies [[`c92f9e3`](https://github.com/selimaytac/hashspan/commit/c92f9e3b15582d6251d6500b90b79d86bd7be2be), [`c20d91d`](https://github.com/selimaytac/hashspan/commit/c20d91da7ec552fc9d6a6d50c62b8eb4b3a2412f), [`15f16ba`](https://github.com/selimaytac/hashspan/commit/15f16bac79dc5dc13506a224fdea9c4abf5d0a34), [`990a2ea`](https://github.com/selimaytac/hashspan/commit/990a2ea75536f6451923bbb51d1f4684aee48b3d), [`2f424f2`](https://github.com/selimaytac/hashspan/commit/2f424f2896d66d7d6b32e448b5643c81f0bee1a2), [`905d2f8`](https://github.com/selimaytac/hashspan/commit/905d2f859b1130657ab92d11dcb90bae86e7517e), [`3a382f2`](https://github.com/selimaytac/hashspan/commit/3a382f26724fc3847359df9da6773b7de0706ed1)]:
  - @hashspan/viem@0.4.0
  - @hashspan/core@0.4.0

## 0.3.2

### Patch Changes

- [#76](https://github.com/selimaytac/hashspan/pull/76) [`db45f8c`](https://github.com/selimaytac/hashspan/commit/db45f8c1f2c791e7ab124ad80acde00db2bd4380) Thanks [@selimaytac](https://github.com/selimaytac)! - `withHashspan(cdp)` accepts a `CdpClient` of the CDP SDK in TypeScript. It used to fail to type-check with "Index
  signature for type 'string' is missing in type 'EvmClient'", so the README's example needed a cast.

- [#80](https://github.com/selimaytac/hashspan/pull/80) [`1f18ec0`](https://github.com/selimaytac/hashspan/commit/1f18ec03db8edff6e61c3d9c611d1cde86f81151) Thanks [@selimaytac](https://github.com/selimaytac)! - `flush()` now also waits for the confirm span of a `waitForTransactionReceipt` on a network-scoped account without a
  reader, and ends it as `timeout` if it cannot wait longer. Before, `flush()` could return while that span was still
  open, so a short-lived process could exit without exporting it.
- Updated dependencies [[`1051084`](https://github.com/selimaytac/hashspan/commit/1051084da16520ce00d337457e4c8823f0ff70ec), [`6cf7e8a`](https://github.com/selimaytac/hashspan/commit/6cf7e8ad87de0789c1093b38b746c984b4efc15b)]:
  - @hashspan/viem@0.3.2

## 0.3.1

### Patch Changes

- [#72](https://github.com/selimaytac/hashspan/pull/72) [`f8828e3`](https://github.com/selimaytac/hashspan/commit/f8828e331f8dd4a1684a97ec87be254bf9de2010) Thanks [@selimaytac](https://github.com/selimaytac)! - Tracing no longer runs getters on call arguments. The adapters read the fields they record (such as `to`, `value`,
  `network` or a transaction's fields) only from own data properties, so a getter with side effects, or one that
  returns a different value per read, now sees the same reads as without tracing; a field behind a getter is left out
  of the span. A `waitForTransactionReceipt` call whose `hash` or `onReplaced` is a getter is passed on untraced.
- Updated dependencies [[`f8828e3`](https://github.com/selimaytac/hashspan/commit/f8828e331f8dd4a1684a97ec87be254bf9de2010), [`d8748f9`](https://github.com/selimaytac/hashspan/commit/d8748f90964eaa5ec643de9fb4d409e6c47bda0c)]:
  - @hashspan/viem@0.3.1

## 0.3.0

### Minor Changes

- [#58](https://github.com/selimaytac/hashspan/pull/58) [`eba7e53`](https://github.com/selimaytac/hashspan/commit/eba7e53c417e2fb525cea0be365fbb543fba5ec5) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `@hashspan/cdp`: `withHashspan(cdp, { reader })` traces transactions sent by Coinbase CDP server accounts
  (`cdp.evm.sendTransaction`, each account's `sendTransaction`, `transfer`, `swap`, `useSpendPermission` and
  network-scoped sends, and `execute()` of swap quotes) as `send` spans, and confirms them in the background through a
  viem `reader`. Pass the same `tracker` as to `@hashspan/viem` to share confirm spans with your own receipt waits. Without a reader, a
  network-scoped account's `waitForTransactionReceipt` records the confirm span. A failed send
  records the CDP API's error type (e.g. `insufficient_balance`) as `error.type`.

### Patch Changes

- Updated dependencies [[`28a83c2`](https://github.com/selimaytac/hashspan/commit/28a83c265f11836a5eca26a99971daa402abc4d3), [`081cab2`](https://github.com/selimaytac/hashspan/commit/081cab2158d8a1e12e76f7abd386e28a79f5b0ff), [`7b99e7b`](https://github.com/selimaytac/hashspan/commit/7b99e7becae4a4f8d6b1416fc9c0df5ff85f64ce)]:
  - @hashspan/core@0.3.0
  - @hashspan/viem@0.3.0
