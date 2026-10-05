# @hashspan/cdp

## 0.12.0

### Patch Changes

- [#376](https://github.com/selimaytac/hashspan/pull/376) [`e474a57`](https://github.com/selimaytac/hashspan/commit/e474a57bd8fc82f167db2dee16c9e05766a7e9b3) Thanks [@selimaytac](https://github.com/selimaytac)! - A network-scoped account's `waitForTransactionReceipt` without a reader now attributes a receipt of another
  transaction only to a replacement the SDK's viem client reported through `onReplaced` (same sender and nonce), with
  its reason. The adapter adds its own `onReplaced`, which calls yours, and passes `{ transactionHash }` on as
  `{ hash, onReplaced }`, the same viem call. A receipt of another hash that viem did not report, such as an endpoint's
  answer for an unrelated transaction, is no longer recorded as a replacement: the confirm span ends with `error.type`
  `_OTHER`. The wait still returns what the SDK returned.

- [#385](https://github.com/selimaytac/hashspan/pull/385) [`743856f`](https://github.com/selimaytac/hashspan/commit/743856f1fe97b2d83fde3d63d2914fb2feee823b) Thanks [@selimaytac](https://github.com/selimaytac)! - More bounds on what telemetry reads:
  
  - A sanitized error message scans at most the first 4096 characters of its first line for URLs and hex values (a hex
    value cut there is still recorded as without the cut); text past that bound is not recorded, and the recorded
    message is cut to 256 characters as before. A URL cut at that bound before its path is recorded as `<url>`.
  - `waitForTransactionReceipt` in `@hashspan/viem`, and the wait of a network-scoped account in `@hashspan/cdp`, read at
    most 64 objects of the arguments' prototype chain when they look up `onReplaced`; arguments with a longer chain are
    passed on untraced and unchanged, as arguments that cannot be read are.
  - `@hashspan/cdp` adds its `onReplaced` to a network-scoped account's wait options only when they are a plain object
    (prototype `Object.prototype` or `null`). Other options, such as a class instance, are passed to the SDK as they are:
    the wait is traced, but a replacement viem reports for it is not attributed.
  
  The options of `withHashspan()` in `@hashspan/viem`, `@hashspan/cdp` and `@hashspan/x402` are read from the object's
  own enumerable properties, so options inherited through a prototype are ignored (ADR 0025). This is now stated in the
  options' documentation and the package READMEs.
- Updated dependencies [[`4fe6f6c`](https://github.com/selimaytac/hashspan/commit/4fe6f6c06e0423baa4ef69d03b42eaeff18f6e50), [`43c0e9d`](https://github.com/selimaytac/hashspan/commit/43c0e9d0de5e9aa83ca237088240ad3ee715bc79), [`4fe6f6c`](https://github.com/selimaytac/hashspan/commit/4fe6f6c06e0423baa4ef69d03b42eaeff18f6e50), [`743856f`](https://github.com/selimaytac/hashspan/commit/743856f1fe97b2d83fde3d63d2914fb2feee823b), [`3624816`](https://github.com/selimaytac/hashspan/commit/36248162cc7171309ed1ff1f075f528ac269189d), [`cd105c2`](https://github.com/selimaytac/hashspan/commit/cd105c2d23a5d569d6e2df7fb2fe0d097a22a76d), [`a3c6f3a`](https://github.com/selimaytac/hashspan/commit/a3c6f3ab62289b6488e0217943124e105b57d826), [`9faa618`](https://github.com/selimaytac/hashspan/commit/9faa618cb0166f6a0ac5f45e340093b22ce90a52)]:
  - @hashspan/core@0.12.0
  - @hashspan/viem@0.12.0

## 0.11.0

### Patch Changes

- [#362](https://github.com/selimaytac/hashspan/pull/362) [`0b820da`](https://github.com/selimaytac/hashspan/commit/0b820da151b5025285aedf9576fc415d16480cde) Thanks [@selimaytac](https://github.com/selimaytac)! - The type declarations document every export, and every member of the exported interfaces, with a doc comment.

- [#359](https://github.com/selimaytac/hashspan/pull/359) [`2498693`](https://github.com/selimaytac/hashspan/commit/24986931fb8a7596c823af20a1732b001f57906e) Thanks [@selimaytac](https://github.com/selimaytac)! - More defensive handling of unusual input:
  
  - A failed call is recorded as a failure (`error.type` and error status) also when its error cannot be read, for
    example an error whose `message` is a getter that throws, or a Proxy; the event then has no message. A primitive
    thrown as is (a string, number, bigint or boolean) is recorded as text; a thrown object that is not an Error, with
    no message. Failures of the tracker itself are logged through `diag` with the error's type only.
  - `sanitized` error messages also cut a URL that directly follows other text, such as `rpc_https://...`, to its
    origin.
  - `gen_ai.agent.id` and `gen_ai.agent.name` taken from Baggage are recorded only if they have at most 128 letters,
    digits, spaces and `_ . : @ / -`. Values from the static `agent` option are recorded as given.
  - With `recordFunctionArguments`, binary data (typed arrays, `ArrayBuffer`, `DataView`) is recorded as `0x` hex, so
    the address mode applies to it, instead of an object of its byte values.
  - `withHashspan()` of the viem, cdp and x402 adapters no longer throws for options it cannot read (`null`, a Proxy, a
    getter that throws): unreadable options take their defaults, with a `diag` warning.
  - The adapters' `diag` messages include an error's name only when it is short text; another name, such as a symbol,
    is logged as unknown.
  - The viem adapter keeps one copy of a `writeContract` ABI per contract function instead of one per transaction.
  - A receipt whose `l1Fee` is not a hex quantity is recorded without `blockchain.tx.l1_fee` and `blockchain.tx.fee`;
    the rest of the receipt is recorded as usual instead of the confirmation ending as a failure.

- [#369](https://github.com/selimaytac/hashspan/pull/369) [`1ada0ac`](https://github.com/selimaytac/hashspan/commit/1ada0aca407b91c9fa8ecde983a074a60833a27f) Thanks [@selimaytac](https://github.com/selimaytac)! - README states the package's known limits.
- Updated dependencies [[`4d7af1b`](https://github.com/selimaytac/hashspan/commit/4d7af1b70dd65ab0633e1a1a7df940bb52e437e5), [`044acaa`](https://github.com/selimaytac/hashspan/commit/044acaae5d1b096995a2b28d4a8d74fa9d149545), [`96a967f`](https://github.com/selimaytac/hashspan/commit/96a967f92de7df92327fd04b3ba6d56fda57976d), [`2e0efb5`](https://github.com/selimaytac/hashspan/commit/2e0efb5fbd5039e94d07ac36b9c9bea9d2db09cd), [`0b820da`](https://github.com/selimaytac/hashspan/commit/0b820da151b5025285aedf9576fc415d16480cde), [`85c741a`](https://github.com/selimaytac/hashspan/commit/85c741ab262c254fc37816c8323cd409fab11955), [`2498693`](https://github.com/selimaytac/hashspan/commit/24986931fb8a7596c823af20a1732b001f57906e), [`1ada0ac`](https://github.com/selimaytac/hashspan/commit/1ada0aca407b91c9fa8ecde983a074a60833a27f), [`1ada0ac`](https://github.com/selimaytac/hashspan/commit/1ada0aca407b91c9fa8ecde983a074a60833a27f)]:
  - @hashspan/core@0.11.0
  - @hashspan/viem@0.11.0

## 0.10.0

### Minor Changes

- [#322](https://github.com/selimaytac/hashspan/pull/322) [`d69ba29`](https://github.com/selimaytac/hashspan/commit/d69ba296cb22e090f72b27ac9c2f8c626abf552e) Thanks [@selimaytac](https://github.com/selimaytac)! - Background confirmation and `watch()` now poll again, one polling interval later, after a failed receipt request (an
  HTTP 429, a JSON-RPC error, a request timeout, a connection reset), until their `timeoutMs`, as they already did when
  the receipt was not there yet. Before, one failed request ended the confirm span at once with that error, though the
  next request would have found the receipt. A provider that keeps failing now ends the span as `timeout`. The
  confirmations of `@hashspan/cdp` and `@hashspan/x402` through a `reader` go through `watch()` and behave the same; your
  own `waitForTransactionReceipt` calls are unaffected.

### Patch Changes

- [#313](https://github.com/selimaytac/hashspan/pull/313) [`320b9ee`](https://github.com/selimaytac/hashspan/commit/320b9ee6421dc30f1cf5eced51f4630091055cbc) Thanks [@selimaytac](https://github.com/selimaytac)! - `confirmTimeoutMs` now bounds each bundle receipt request of a completed user operation, not only the time between
  requests: a reader whose request never answers no longer keeps the confirm span open past it, a receipt that arrives
  later is not used, and once `flush()` gives up the work it awaits settles, so the next `flush()` reports success. A
  `confirmTimeoutMs` that is not a finite non-negative number falls back to the default for this wait.

- [#312](https://github.com/selimaytac/hashspan/pull/312) [`d5c59a2`](https://github.com/selimaytac/hashspan/commit/d5c59a2547690620f6a1a39ad416897f57c928d5) Thanks [@selimaytac](https://github.com/selimaytac)! - A confirm span of a network-scoped `waitForTransactionReceipt` or of `waitForUserOperation` now ends when the wait's
  result or error cannot be read (a Proxy whose traps throw, an error whose `name` getter throws), as a failure with
  `error.type` `_OTHER`; before, it could stay open while `flush()` reported success. The error's name is read from an
  own data property.

- [#320](https://github.com/selimaytac/hashspan/pull/320) [`c6f476c`](https://github.com/selimaytac/hashspan/commit/c6f476c3fc421402aa9df5dc884d1714b84c80f4) Thanks [@selimaytac](https://github.com/selimaytac)! - A send span of `sendTransaction`, `transfer` or `sendUserOperation` now ends when the SDK call rejects with a value
  that cannot be read (a Proxy whose traps throw), as a failure with `error.type` `_OTHER`; before, it stayed open and
  was never exported. The rejection still reaches the caller unchanged.

- [#281](https://github.com/selimaytac/hashspan/pull/281) [`16658b9`](https://github.com/selimaytac/hashspan/commit/16658b9c19b7147a80ef7a216be61ee9d9966d2a) Thanks [@selimaytac](https://github.com/selimaytac)! - Tracing work that `flush()` awaits can no longer surface as an unhandled rejection in the application's process if it
  rejects, and `flush()` still resolves once it has settled.

- [#308](https://github.com/selimaytac/hashspan/pull/308) [`6635459`](https://github.com/selimaytac/hashspan/commit/663545943b5087b35e2f08283f6f573fec882c3f) Thanks [@selimaytac](https://github.com/selimaytac)! - `withHashspan()` no longer throws for a client whose `evm` cannot be read or marked as traced (a Proxy, a frozen
  object, a missing `evm`): the client is then not traced, with a `diag` warning.

- [#340](https://github.com/selimaytac/hashspan/pull/340) [`a81e328`](https://github.com/selimaytac/hashspan/commit/a81e328723bd8197d88393926e829c633601bce3) Thanks [@selimaytac](https://github.com/selimaytac)! - `flush()` reads `timeoutMs` as an own data property and always resolves to a boolean. Options it cannot read (`null`,
  a revoked Proxy, a getter or a Proxy trap that throws) made the viem and cdp `flush()` reject, and the x402 one
  resolve `false` without waiting; they now use the default of 10 000 ms, as does a `timeoutMs` that is not a
  non-negative number.
- Updated dependencies [[`03889c2`](https://github.com/selimaytac/hashspan/commit/03889c2bb75eac3a48c1ff7b16b6d335e1a543aa), [`6635459`](https://github.com/selimaytac/hashspan/commit/663545943b5087b35e2f08283f6f573fec882c3f), [`a81e328`](https://github.com/selimaytac/hashspan/commit/a81e328723bd8197d88393926e829c633601bce3), [`3182feb`](https://github.com/selimaytac/hashspan/commit/3182febabd7633aa0951ea4bc3e32d6ed178d0a5), [`0c7bb6e`](https://github.com/selimaytac/hashspan/commit/0c7bb6e0d0abeedc25dd4ff4784bf2a760d9a7b6), [`d69ba29`](https://github.com/selimaytac/hashspan/commit/d69ba296cb22e090f72b27ac9c2f8c626abf552e), [`6635459`](https://github.com/selimaytac/hashspan/commit/663545943b5087b35e2f08283f6f573fec882c3f)]:
  - @hashspan/core@0.10.0
  - @hashspan/viem@0.10.0

## 0.9.1

### Patch Changes

- [#259](https://github.com/selimaytac/hashspan/pull/259) [`4b700e2`](https://github.com/selimaytac/hashspan/commit/4b700e262c45d68848647f7681cd2413919fdcf6) Thanks [@selimaytac](https://github.com/selimaytac)! - A network name that matches an `Object.prototype` member, such as `constructor`, is no longer taken for a known
  network, so no span starts with a non-numeric chain id. The methods `withHashspan()` wraps in place keep the
  enumerability of the original property and are not enumerable where the SDK's were inherited, so `Object.keys`,
  object spread and `JSON.stringify` of `cdp.evm` and of accounts are the same as before wrapping; a read-only or
  accessor property is left as it is.

## 0.9.0

### Patch Changes

- [#219](https://github.com/selimaytac/hashspan/pull/219) [`6f0846d`](https://github.com/selimaytac/hashspan/commit/6f0846df0ce3c150ce66d5fcdf20204ffc702dac) Thanks [@selimaytac](https://github.com/selimaytac)! - The package's npm homepage is now https://hashspan.dev.
- Updated dependencies [[`4f86829`](https://github.com/selimaytac/hashspan/commit/4f86829bca5feb6d2c3cff6f5f0d38f29018f9cc), [`4f86829`](https://github.com/selimaytac/hashspan/commit/4f86829bca5feb6d2c3cff6f5f0d38f29018f9cc), [`8efcfa6`](https://github.com/selimaytac/hashspan/commit/8efcfa683f7cf737f84164c768cf1e2f897c3c8a), [`8efcfa6`](https://github.com/selimaytac/hashspan/commit/8efcfa683f7cf737f84164c768cf1e2f897c3c8a), [`4a3ccd5`](https://github.com/selimaytac/hashspan/commit/4a3ccd5d63b43ffd166b9cfae609a0fcca1882d6), [`4a3ccd5`](https://github.com/selimaytac/hashspan/commit/4a3ccd5d63b43ffd166b9cfae609a0fcca1882d6), [`6f0846d`](https://github.com/selimaytac/hashspan/commit/6f0846df0ce3c150ce66d5fcdf20204ffc702dac), [`c9795db`](https://github.com/selimaytac/hashspan/commit/c9795db3a1aa46ea7f93b9f7130c73c9a0a0e4e0), [`18f2f3c`](https://github.com/selimaytac/hashspan/commit/18f2f3c1a94ab75eb49bb027f34d61355d13e3b6), [`ad6b069`](https://github.com/selimaytac/hashspan/commit/ad6b069a70f703785576dde4e45051d1419b34e8), [`0be88f5`](https://github.com/selimaytac/hashspan/commit/0be88f5edf0575745bd8a989199bb4fac3bf1110)]:
  - @hashspan/core@0.9.0
  - @hashspan/viem@0.9.0

## 0.8.1

### Patch Changes

- [#190](https://github.com/selimaytac/hashspan/pull/190) [`6d03146`](https://github.com/selimaytac/hashspan/commit/6d03146800092ce524d67837b42b04d4c9a23e7f) Thanks [@selimaytac](https://github.com/selimaytac)! - A network-scoped account's `waitForTransactionReceipt` without a reader records a flashblocks preconfirmation (a
  receipt with a zero or null block hash, such as Base RPCs return before the block is sealed) without
  `blockchain.tx.effective_gas_price`, `l1_fee` and `fee`, as ADR 0024 does for `@hashspan/viem`: its fee can be
  another transaction's, and without a reader there is no sealed receipt to read. The caller's receipt is unchanged.

## 0.8.0

### Minor Changes

- [#182](https://github.com/selimaytac/hashspan/pull/182) [`2c69131`](https://github.com/selimaytac/hashspan/commit/2c6913136771dd6c6b8e3727b420a26c1c3e6b7c) Thanks [@selimaytac](https://github.com/selimaytac)! - Smart accounts (ADR 0021): smart accounts from `createSmartAccount`, `getSmartAccount`, `getOrCreateSmartAccount`
  and `updateSmartAccount` are wrapped in place. Their `sendUserOperation`, `transfer`, `swap`, `useSpendPermission`
  and quote `execute()`, the same on network-scoped smart accounts, and `cdp.evm.sendUserOperation`,
  `prepareAndSendUserOperation`, `createSpendPermission` and `revokeSpendPermission` record a user operation `send`
  span with its hash, sender and number of calls. `waitForUserOperation` records a linked `confirm` span with the
  bundle transaction's hash; with a reader, the operation's success, gas used, cost, nonce, paymaster and EntryPoint
  come from the bundle receipt's `UserOperationEvent`. CDP's `failed` ends it with `error.type` `failed`, and the SDK's
  `TimeoutError` as `timeout`. `CDP_NETWORK_CHAIN_IDS` gains `bnb`, the user operation name of BNB Smart Chain.
  Requires `@hashspan/core` with user operations; with an older tracker, user operations are passed on untraced.

### Patch Changes

- Updated dependencies [[`1ba39b9`](https://github.com/selimaytac/hashspan/commit/1ba39b9d18ef63bb4d79ea691f9080cb1d8a8dc5), [`8446f17`](https://github.com/selimaytac/hashspan/commit/8446f17465b63d1660932b6edc1f9426fb6c4efa), [`c8bc60e`](https://github.com/selimaytac/hashspan/commit/c8bc60e4984e16bfd86671ae825e7f19a83f6329), [`c8bc60e`](https://github.com/selimaytac/hashspan/commit/c8bc60e4984e16bfd86671ae825e7f19a83f6329), [`09628e2`](https://github.com/selimaytac/hashspan/commit/09628e2c64131d5df3deee0c58e69c4859f4df3a)]:
  - @hashspan/core@0.8.0
  - @hashspan/viem@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [[`3fbc570`](https://github.com/selimaytac/hashspan/commit/3fbc57094efd99dd218aadb5e1d72f15bbbd4d8c), [`d1be4f8`](https://github.com/selimaytac/hashspan/commit/d1be4f8ec2deddb0060dc69d7de0b906ec4c3dcd), [`a777da8`](https://github.com/selimaytac/hashspan/commit/a777da8ecfe81d9e8221037271dcee07642d4023)]:
  - @hashspan/core@0.7.0
  - @hashspan/viem@0.7.0

## 0.6.0

### Patch Changes

- [#143](https://github.com/selimaytac/hashspan/pull/143) [`6146a93`](https://github.com/selimaytac/hashspan/commit/6146a9392eaf0e81c9dce6715e9e74e7d4d20461) Thanks [@selimaytac](https://github.com/selimaytac)! - Wrapping a result of the SDK can no longer fail a call that succeeded: an account, quote or network-scoped account
  that cannot be wrapped, such as a frozen one, is returned as it is, untraced, and one such account in
  `listAccounts` leaves the others traced. An account is marked as wrapped only once all its methods were replaced,
  and wrapping it again traces each call once. A call whose options throw when read is made untraced.
- Updated dependencies [[`7ba73bb`](https://github.com/selimaytac/hashspan/commit/7ba73bb2e2a87c157c2819d23b66b6266925472a), [`071730f`](https://github.com/selimaytac/hashspan/commit/071730f525c7f9446b5591dd3ba3b72e6bd34780), [`c898941`](https://github.com/selimaytac/hashspan/commit/c898941305240ee1b13513d0f9de14ccf984c47d)]:
  - @hashspan/core@0.6.0
  - @hashspan/viem@0.6.0

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
