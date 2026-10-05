# @hashspan/x402

## 0.12.0

### Patch Changes

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

- [#382](https://github.com/selimaytac/hashspan/pull/382) [`9faa618`](https://github.com/selimaytac/hashspan/commit/9faa618cb0166f6a0ac5f45e340093b22ce90a52) Thanks [@selimaytac](https://github.com/selimaytac)! - README: how to try a payment on a local Anvil chain with the SDK's facilitator in process; that a payment the
  client's spend controls refuse is not traced, and a token other than the default ones needs an `allowedAssets`
  entry; and that registering a scheme is not a hook and may come before `withHashspan()`.
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

- [#340](https://github.com/selimaytac/hashspan/pull/340) [`a81e328`](https://github.com/selimaytac/hashspan/commit/a81e328723bd8197d88393926e829c633601bce3) Thanks [@selimaytac](https://github.com/selimaytac)! - `flush()` reads `timeoutMs` as an own data property and always resolves to a boolean. Options it cannot read (`null`,
  a revoked Proxy, a getter or a Proxy trap that throws) made the viem and cdp `flush()` reject, and the x402 one
  resolve `false` without waiting; they now use the default of 10 000 ms, as does a `timeoutMs` that is not a
  non-negative number.

- [#308](https://github.com/selimaytac/hashspan/pull/308) [`6635459`](https://github.com/selimaytac/hashspan/commit/663545943b5087b35e2f08283f6f573fec882c3f) Thanks [@selimaytac](https://github.com/selimaytac)! - A settlement response that cannot be read ends the payment span with `error.type` `_OTHER` instead of leaving it open
  until its deadline. `withHashspan()` no longer throws for a client or a tracker it cannot read: the payments are then
  not traced, with a `diag` warning.
- Updated dependencies [[`03889c2`](https://github.com/selimaytac/hashspan/commit/03889c2bb75eac3a48c1ff7b16b6d335e1a543aa), [`6635459`](https://github.com/selimaytac/hashspan/commit/663545943b5087b35e2f08283f6f573fec882c3f), [`a81e328`](https://github.com/selimaytac/hashspan/commit/a81e328723bd8197d88393926e829c633601bce3), [`3182feb`](https://github.com/selimaytac/hashspan/commit/3182febabd7633aa0951ea4bc3e32d6ed178d0a5), [`0c7bb6e`](https://github.com/selimaytac/hashspan/commit/0c7bb6e0d0abeedc25dd4ff4784bf2a760d9a7b6), [`d69ba29`](https://github.com/selimaytac/hashspan/commit/d69ba296cb22e090f72b27ac9c2f8c626abf552e), [`6635459`](https://github.com/selimaytac/hashspan/commit/663545943b5087b35e2f08283f6f573fec882c3f)]:
  - @hashspan/core@0.10.0
  - @hashspan/viem@0.10.0

## 0.9.0

### Patch Changes

- [#219](https://github.com/selimaytac/hashspan/pull/219) [`6f0846d`](https://github.com/selimaytac/hashspan/commit/6f0846df0ce3c150ce66d5fcdf20204ffc702dac) Thanks [@selimaytac](https://github.com/selimaytac)! - The package's npm homepage is now https://hashspan.dev.

- [#254](https://github.com/selimaytac/hashspan/pull/254) [`0be88f5`](https://github.com/selimaytac/hashspan/commit/0be88f5edf0575745bd8a989199bb4fac3bf1110) Thanks [@selimaytac](https://github.com/selimaytac)! - `watch()` with a `chainId` and a client without a chain now asks the client for its chain id (`eth_chainId`) and
  records nothing when the two differ, as it already did for a client with a chain. Before, the transaction was polled
  on the client's chain and recorded under the given chain id. In `@hashspan/x402` that chain id comes from the paid
  server, so a reader without a chain could record a confirm span, and its `blockchain.chain.id` metric label, for any
  chain the server named.
- Updated dependencies [[`4f86829`](https://github.com/selimaytac/hashspan/commit/4f86829bca5feb6d2c3cff6f5f0d38f29018f9cc), [`4f86829`](https://github.com/selimaytac/hashspan/commit/4f86829bca5feb6d2c3cff6f5f0d38f29018f9cc), [`8efcfa6`](https://github.com/selimaytac/hashspan/commit/8efcfa683f7cf737f84164c768cf1e2f897c3c8a), [`8efcfa6`](https://github.com/selimaytac/hashspan/commit/8efcfa683f7cf737f84164c768cf1e2f897c3c8a), [`4a3ccd5`](https://github.com/selimaytac/hashspan/commit/4a3ccd5d63b43ffd166b9cfae609a0fcca1882d6), [`4a3ccd5`](https://github.com/selimaytac/hashspan/commit/4a3ccd5d63b43ffd166b9cfae609a0fcca1882d6), [`6f0846d`](https://github.com/selimaytac/hashspan/commit/6f0846df0ce3c150ce66d5fcdf20204ffc702dac), [`c9795db`](https://github.com/selimaytac/hashspan/commit/c9795db3a1aa46ea7f93b9f7130c73c9a0a0e4e0), [`18f2f3c`](https://github.com/selimaytac/hashspan/commit/18f2f3c1a94ab75eb49bb027f34d61355d13e3b6), [`ad6b069`](https://github.com/selimaytac/hashspan/commit/ad6b069a70f703785576dde4e45051d1419b34e8), [`0be88f5`](https://github.com/selimaytac/hashspan/commit/0be88f5edf0575745bd8a989199bb4fac3bf1110)]:
  - @hashspan/core@0.9.0
  - @hashspan/viem@0.9.0

## 0.8.0

### Minor Changes

- [#157](https://github.com/selimaytac/hashspan/pull/157) [`7485f5f`](https://github.com/selimaytac/hashspan/commit/7485f5fd118e7b1f75c72f89807d6c19830a88e2) Thanks [@selimaytac](https://github.com/selimaytac)! - A Permit2 settlement is now verified by its nonce (ADR 0017): with a reader, when the receipt carries an `exact`
  Permit2 or `upto` payment, the mined transaction (the replacement, when the reported one was replaced) is read with
  one more request through the reader, and `blockchain.payment.verified` is `true` only when its input passes the
  payer's Permit2 nonce and the payer as owner to the proxy. The transaction of an earlier payment is therefore `false`
  in any client or process, also after a restart; the in-memory list of the last 1000 verified transactions is removed.
  A transaction that cannot be read gives no verdict.

### Patch Changes

- Updated dependencies [[`1ba39b9`](https://github.com/selimaytac/hashspan/commit/1ba39b9d18ef63bb4d79ea691f9080cb1d8a8dc5), [`8446f17`](https://github.com/selimaytac/hashspan/commit/8446f17465b63d1660932b6edc1f9426fb6c4efa), [`c8bc60e`](https://github.com/selimaytac/hashspan/commit/c8bc60e4984e16bfd86671ae825e7f19a83f6329), [`c8bc60e`](https://github.com/selimaytac/hashspan/commit/c8bc60e4984e16bfd86671ae825e7f19a83f6329), [`09628e2`](https://github.com/selimaytac/hashspan/commit/09628e2c64131d5df3deee0c58e69c4859f4df3a)]:
  - @hashspan/core@0.8.0
  - @hashspan/viem@0.8.0

## 0.7.0

### Minor Changes

- [#149](https://github.com/selimaytac/hashspan/pull/149) [`c36b3a3`](https://github.com/selimaytac/hashspan/commit/c36b3a35d9191e2f0ed0193904f9fc474922558f) Thanks [@selimaytac](https://github.com/selimaytac)! - With a reader, `blockchain.payment.verified` is also recorded for Permit2 payments (ADR 0017): for an `exact`
  payment, `true` when the settlement transaction was sent to the x402 proxy the payer authorized, the proxy emitted its
  settlement event and the token emitted `Transfer` from the payer to `payTo` of exactly the amount; for `upto`, when
  the transaction was also sent by the facilitator the authorization names, and the transfer is of more than nothing, at
  most the authorized maximum and, when the settlement reports an amount, exactly that amount. Since no log carries the
  payment's nonce, a settlement transaction already verified for an earlier Permit2 payment of the same `withHashspan()`
  (among the last 1000) is `false` for a later one.

### Patch Changes

- Updated dependencies [[`3fbc570`](https://github.com/selimaytac/hashspan/commit/3fbc57094efd99dd218aadb5e1d72f15bbbd4d8c), [`d1be4f8`](https://github.com/selimaytac/hashspan/commit/d1be4f8ec2deddb0060dc69d7de0b906ec4c3dcd), [`a777da8`](https://github.com/selimaytac/hashspan/commit/a777da8ecfe81d9e8221037271dcee07642d4023)]:
  - @hashspan/core@0.7.0
  - @hashspan/viem@0.7.0

## 0.6.0

### Minor Changes

- [#136](https://github.com/selimaytac/hashspan/pull/136) [`a5e809a`](https://github.com/selimaytac/hashspan/commit/a5e809a9b51765497329b5df59e435a6cb3cb247) Thanks [@selimaytac](https://github.com/selimaytac)! - With a reader, a payment span records `blockchain.payment.verified` (ADR 0017): for an `exact` payment authorized
  with EIP-3009, `true` when the settlement transaction's receipt carries the token's `AuthorizationUsed` with the
  payment's nonce and its `Transfer` from the payer to `payTo` of exactly the amount, `false` when it does not, and no
  attribute when no check was possible. The payment span is then exported once the receipt is checked, with its end
  time unchanged.

### Patch Changes

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

- [#98](https://github.com/selimaytac/hashspan/pull/98) [`20a830a`](https://github.com/selimaytac/hashspan/commit/20a830a209dbac23944f847c0fc849448abfd4b6) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `@hashspan/x402`: `withHashspan(client, { reader })` registers hooks on an `x402Client`, so each payment made
  through `@x402/fetch`, `@x402/axios` or `@x402/mcp` becomes a `payment {chainId}` span with the payer, recipient,
  asset, amount, scheme, resource and settlement, and, with a reader, a linked confirm span for the settling
  transaction (ADR 0013). The confirm span does not check that the reported transaction is the payment, and revert
  reasons of settlements are replayed only with `decodeRevertReason: true`. Payments without a response end as
  `timeout`; x402 v1 and non-EVM payments are not traced.

### Patch Changes

- Updated dependencies [[`c92f9e3`](https://github.com/selimaytac/hashspan/commit/c92f9e3b15582d6251d6500b90b79d86bd7be2be), [`c20d91d`](https://github.com/selimaytac/hashspan/commit/c20d91da7ec552fc9d6a6d50c62b8eb4b3a2412f), [`15f16ba`](https://github.com/selimaytac/hashspan/commit/15f16bac79dc5dc13506a224fdea9c4abf5d0a34), [`990a2ea`](https://github.com/selimaytac/hashspan/commit/990a2ea75536f6451923bbb51d1f4684aee48b3d), [`2f424f2`](https://github.com/selimaytac/hashspan/commit/2f424f2896d66d7d6b32e448b5643c81f0bee1a2), [`905d2f8`](https://github.com/selimaytac/hashspan/commit/905d2f859b1130657ab92d11dcb90bae86e7517e), [`3a382f2`](https://github.com/selimaytac/hashspan/commit/3a382f26724fc3847359df9da6773b7de0706ed1)]:
  - @hashspan/viem@0.4.0
  - @hashspan/core@0.4.0
