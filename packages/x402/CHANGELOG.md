# @hashspan/x402

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
