# 0026. The receipt of a wait for several confirmations is read again

- Status: proposed
- Date: 2026-10-04

## Context

A wait with `confirmations` above 1 returns the receipt it read first. viem's `waitForTransactionReceipt` reads the
receipt once, then only counts blocks until enough confirmations passed; it does not read the receipt again. When a
chain reorganisation during the wait moves the transaction to another block, or removes it, the caller still gets the
first receipt, and the confirm span records it: `blockchain.tx.status` `success` and the old
`blockchain.block.number`, for a transaction that may no longer be on the chain at all (#306, pinned in
`packages/viem/test/reorg.int.test.ts`). A wait for several confirmations is the case where a caller asked for
finality, so a span that reports a removed transaction as settled is the wrong answer exactly where it matters.

The tracker already records chain data rather than the caller's copy when the two can differ: ADR 0024 reads the
receipt again for a flashblocks preconfirmation, off the caller's path, bounded, and records the sealed receipt. ADR
0016 keeps `blockchain.tx.status` for chain data only and puts what the observer saw in `error.type`.

## Decision

- When a traced `waitForTransactionReceipt` with `confirmations` above 1 resolves, the confirm span reads
  `eth_getTransactionReceipt` once more, after the caller has its result, off the call path (ADR 0009) and tracked
  for `flush()` (ADR 0010), with the wait's own request timeout.
  - The receipt it reads again has the caller's `blockHash`: the span records the caller's receipt, as today.
  - Otherwise (no receipt, or a receipt in another block), the span also reads `eth_getBlockByNumber` at the height of
    the caller's receipt, to tell a reorganisation from a node that is behind or answers inconsistently:
    - The node has no block at that height: it is behind, and the span records the caller's receipt.
    - The block's hash is the caller's `blockHash`: that block is still on the chain, the receipt read again is not
      trusted, and the span records the caller's receipt.
    - The block's hash differs: the caller's block was reorganised away. A receipt in another block is recorded
      (block number, status, gas and fees of that block); no receipt ends the span with error status and `error.type`
      `not_on_chain`, without `blockchain.tx.status`, since the transaction's outcome on the chain is not known at
      that point (ADR 0016).
  - A request that fails, or an answer that cannot be read, leaves the caller's receipt recorded: `not_on_chain` and a
    moved receipt are recorded only when every request of the check succeeded.
- The caller's result never changes: the wait returns what viem returned.
- The span keeps the time the caller's wait resolved as its end time, as ADR 0024 keeps the preconfirmation's.
- A replacement (ADR 0008) keeps its own path: a receipt of another transaction is not read again.
- Background confirmation and `watch()` wait for one confirmation and end on the first receipt; they are not
  affected.

## Consequences

- A wait for several confirmations makes one more `eth_getTransactionReceipt`, and one `eth_getBlockByNumber` more
  only when that receipt is missing or in another block. The implementation adds a `confirmations: 2` case to `packages/viem/test/request-count.int.test.ts` and the row to the requests table of
  docs/architecture.md.
- `not_on_chain` is a new value of `error.type` on confirm spans, documented in docs/semconv.md: a minor change with
  a changeset. The confirmation duration histogram records it as an error outcome like `timeout`.
- The pinned rows of `reorg.int.test.ts` ("moved to another block", "dropped") change to the new endings, and the
  RPC fault tables get rows for a failed re-read, a node without the block, and a null receipt from a node whose block
  at that height still has the caller's hash.
- The paragraph on chain reorganisations in docs/semconv.md changes: a wait for several confirmations records the
  receipt it read last.
- A reorganisation after the span ended is still not revised (out of scope, as today).
- Implementation waits until the confirm path changes of #311 are merged, since they touch the same code.
- The block check exists because a public RPC endpoint can spread requests over nodes that are a few blocks apart: a
  re-read served by a node that is behind returns no receipt for a transaction that is on the chain, and treating that
  as a reorganisation would report a settled transaction as gone.

## History

- 2026-10-04: the block hash check was added before acceptance, after a review of how transaction managers and
  client libraries confirm transactions found that none checks a receipt's block at N confirmations and that a null
  receipt alone does not tell a reorganisation from a lagging node. The maintainer approved the decision; the status
  stays proposed until the implementation is compared with it.
