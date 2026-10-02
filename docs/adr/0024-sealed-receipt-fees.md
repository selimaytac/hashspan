# 0024. Fees from the sealed receipt, not a preconfirmation

- Status: accepted
- Date: 2026-10-02

## Context

Base RPC nodes serve flashblocks preconfirmations: `eth_getTransactionReceipt` returns a receipt about 200 ms after a
transaction is included in a flashblock, before its block is sealed. viem's `waitForTransactionReceipt` resolves on
it. Its status, block number and gas used matched the sealed receipt in every sample, but its block hash is zero, and
its `l1Fee` can be the L1 fee of an earlier transaction of the same block: on Base Sepolia, 117 of 311 preconfirmed receipts on `sepolia.base.org`
differed from their sealed receipts on 2026-10-02, and every differing value was another transaction's
(upstream: base/base#5473). The adapter copied that value into `blockchain.tx.l1_fee`, `blockchain.tx.fee` and the
fee histogram (#179).

## Decision

- `@hashspan/viem` treats a receipt with a zero or null `blockHash` as a preconfirmation. Sealed receipts always carry
  their block's hash, so other chains and sealed receipts cost no extra request.
- For a preconfirmation, the confirm span waits, off the caller's path, for the sealed receipt: it reads
  `eth_getTransactionReceipt` again every polling interval (1 s without one), for at most 30 s and never past the
  background confirmation's own deadline, and records that receipt. The revert reason is fetched after it.
- If no sealed receipt comes in time, or `flush()` cannot wait for it, the span records the preconfirmation without
  `effective_gas_price`, `l1_fee` and `fee`: a fee without the L1 part would look valid and be too low. Status, block
  number and gas used are kept, as the node reported them for the preconfirmation, which may never have been sealed.
  A `diag` warning says so when the wait runs out.
- The span keeps the preconfirmation's arrival as its end time, so its duration and the confirmation duration
  histogram (ADR 0020) measure the wait the caller saw.
- The caller's `waitForTransactionReceipt` still returns what the node returned, and `watch()`'s `onReceipt` still gets
  the receipt viem resolved with: telemetry never changes the caller's result.
- The sealed wait runs after the background confirmation's slot is released (ADR 0018): it is short and bounded, and
  holding the slot would delay other confirmations for a correction to one span.

## Consequences

- On flashblocks RPCs, confirm spans are exported up to one block (about 2 s on Base) later than the caller's wait
  returns, with the end time of the preconfirmation, and each confirmation makes about one more receipt request.
- Adapters that record a receipt they did not get through `@hashspan/viem`'s confirm path (such as `@hashspan/cdp`'s
  wrapped `waitForTransactionReceipt`) need the same check; that is a follow-up.
- When the node bug is fixed upstream, the wait still applies: a preconfirmation's fee is not final by definition.

## Amendment (2026-10-03): the CDP follow-up is done

`@hashspan/cdp` applies the check to the receipt of its wrapped `waitForTransactionReceipt` (#190): without a reader,
a receipt with a zero or null block hash is recorded without `effective_gas_price`, `l1_fee` and `fee`, since the
adapter has no client to read the sealed receipt with; with a reader, the background confirmation records it from the
sealed receipt, as above.
