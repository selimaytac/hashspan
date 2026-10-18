# @hashspan/mpp

## 0.1.0

### Minor Changes

- [#450](https://github.com/selimaytac/hashspan/pull/450) [`b6ca775`](https://github.com/selimaytac/hashspan/commit/b6ca775ca80ab38649588952e5a697bfd60f2883) Thanks [@selimaytac](https://github.com/selimaytac)! - Add `@hashspan/mpp`, 0.x while mppx is (ADR 0029): `withHashspan(mppx, { reader })` registers observers on the client
  `Mppx.create()` returns, so each Tempo `charge` paid through its `fetch`, push or pull, becomes a `payment {chainId}`
  span with the payer, recipient, asset, amount, `mpp.mode`, `mpp.challenge.id`, the resource and the settlement. The
  payer's own hash is recorded from the start (push, and pull without a fee payer), and kept over another one the server
  reports; with a reader, a linked confirm span, and `blockchain.payment.verified` from the transfer of the payer with
  the challenge's memo, and each split. Payments without an outcome event end as `timeout`; mppx's `payment.failed` is observed only with `observeFailures: true`,
  since observing it makes mppx buffer and cut 5xx bodies. Requires `@hashspan/core`
  1.2, `mppx` `~0.13.5` and `viem` 2.57.1 or later.

### Patch Changes

- Updated dependencies [[`b6ca775`](https://github.com/selimaytac/hashspan/commit/b6ca775ca80ab38649588952e5a697bfd60f2883)]:
  - @hashspan/core@1.2.0
