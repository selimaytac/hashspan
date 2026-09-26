# 0005. Decode revert reasons of mined transactions by replay

- Status: accepted
- Date: 2026-09-26

## Context

A receipt only says that a transaction reverted, not why. The reason is the revert data returned by the failing
call, which is not stored on chain. Knowing it ("insufficient balance", a custom error with arguments) is usually
the first thing needed when an agent's transaction fails.

## Decision

- When a receipt has status `reverted`, the adapter fetches the transaction and replays it with `eth_call` against
  the state of the previous block, then decodes the revert data:
  - `Error(string)` as its message, `Panic(uint256)` as `Panic(0x..)`;
  - custom errors with the contract ABI when known (e.g. from `writeContract`), formatted as `Name(arg, ...)`;
  - otherwise the 4-byte error selector.
- The result is recorded as `blockchain.tx.revert.reason` on the `confirm` span.
- Enabled by default; `decodeRevertReason: false` turns it off.
- The caller's `waitForTransactionReceipt` returns as soon as the receipt is available; the `confirm` span ends
  after the reason has been fetched.

## Consequences

- Two extra RPC requests (`eth_getTransactionByHash`, `eth_call`) per reverted transaction, sent to the user's
  provider; none for successful transactions.
- Best effort: earlier transactions in the same block can change the state the transaction saw, and some providers
  do not serve historical state. In those cases the reason may be missing or differ.
- The `confirm` span duration includes fetching the reason for reverted transactions.
