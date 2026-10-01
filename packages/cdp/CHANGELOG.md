# @hashspan/cdp

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
