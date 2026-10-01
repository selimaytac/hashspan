# @hashspan/x402

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
