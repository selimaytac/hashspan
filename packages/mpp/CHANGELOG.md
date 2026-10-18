# @hashspan/mpp

## 0.1.1

### Patch Changes

- [#456](https://github.com/selimaytac/hashspan/pull/456) [`d494f00`](https://github.com/selimaytac/hashspan/commit/d494f00e661d5c5654db692eca964bce8819bb17) Thanks [@selimaytac](https://github.com/selimaytac)! - Clearer npm description and keywords

- [#462](https://github.com/selimaytac/hashspan/pull/462) [`0d9f7e1`](https://github.com/selimaytac/hashspan/commit/0d9f7e138ebf2f98c1111c503a3595674b2f2392) Thanks [@selimaytac](https://github.com/selimaytac)! - Stricter checks before recording a verified payment: for a sponsored pull, whose hash only the server's `reference`
  names, `blockchain.payment.verified` is `true` only when the mined transaction, read once through the reader, was
  sent by the payer with the nonce and validity fields of the transaction the payer signed; otherwise the payment has no
  verdict. Push and unsponsored pull are unchanged. `flush()` does not wait for unpaid challenges: it waits only for
  payments whose credential was created, and a challenge that was never paid is still dropped at its deadline.
- Updated dependencies [[`d494f00`](https://github.com/selimaytac/hashspan/commit/d494f00e661d5c5654db692eca964bce8819bb17), [`af72f4e`](https://github.com/selimaytac/hashspan/commit/af72f4eb7bc848f493bd7f9c2978cd2fdb676163), [`db5851b`](https://github.com/selimaytac/hashspan/commit/db5851b79c5b33317cd34705af5f87a9f8a25c5e)]:
  - @hashspan/core@1.2.1
  - @hashspan/viem@1.2.1

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
