# 0021. User operations of smart accounts

- Status: proposed
- Date: 2026-10-02

## Context

Agent wallets increasingly are smart accounts. An ERC-4337 smart account does not send a transaction: it signs a
user operation, which a bundler puts into a bundle transaction that the bundler sends. Today nothing of this is
traced: viem's bundler client has `sendUserOperation` and `waitForUserOperationReceipt` but no `sendTransaction`,
and the CDP adapter does not wrap smart accounts (ADR 0012).

What the SDKs give (viem 2.57, `@coinbase/cdp-sdk` 1.57):

- `sendUserOperation` returns the `userOpHash`; no transaction hash exists yet.
- viem's `waitForUserOperationReceipt` returns `success`, `actualGasCost`, `actualGasUsed`, `sender`, `nonce`,
  `entryPoint`, `paymaster` (when one paid), this operation's logs, and the receipt of the whole bundle transaction.
  CDP's `waitForUserOperation` returns `complete` with the transaction hash, or `failed`.
- One bundle transaction can carry the operations of many accounts, and a bundler can resubmit a bundle under a new
  transaction hash. The bundle transaction can succeed while an operation in it reverts.
- Every EntryPoint version (0.6 to 0.9) emits the same `UserOperationEvent(userOpHash, sender, paymaster, nonce,
  success, actualGasCost, actualGasUsed)`, with the `userOpHash` indexed.
- Inside viem's account abstraction code, nothing calls `sendUserOperation` or `waitForUserOperationReceipt`, so
  wrapping those two cannot trace an operation twice.

## Decision

- **A user operation is identified by its chain and `userOpHash`, not by a transaction hash.** Its spans are the
  same `send {chainId}` and `confirm {chainId}` as a transaction's, with `blockchain.operation.name` `send` and
  `confirm`, so agent traces read the same; the difference is in the attributes.
- **The send span** covers the call that hands the operation to the bundler, until the `userOpHash` is returned.
  ADR 0015 applies: the call runs with the send span active. It records `blockchain.user_operation.hash`, the
  smart account as `blockchain.user_operation.sender`, the EntryPoint address, and the number of calls; it has no
  `blockchain.tx.hash` and no `blockchain.tx.from` (the transaction's sender is the bundler).
- **The confirm span** ends with the operation's receipt. It is keyed by chain and `userOpHash`, in a key space
  separate from transaction hashes, so ADR 0007 (one confirm span per key) holds and ADR 0008 (replaced
  transactions) does not apply. It records `blockchain.user_operation.success`, `.gas.used`, `.gas.cost` (the
  operation's own `actualGasCost`, in wei), `.paymaster` when one paid, and the bundle transaction's
  `blockchain.tx.hash` and `blockchain.block.number`.
- **Outcomes.** A reverted operation ends with error status and `error.type` `reverted`, with its revert reason
  when one is known. `blockchain.tx.status` is not set on these spans: it describes the bundle transaction, which
  can succeed while the operation reverts. A CDP `failed` ends as an error; a wait that gives up ends as `timeout`
  (ADR 0016).
- **Fees.** `blockchain.tx.fee`, `.gas_used` and `.effective_gas_price` are not derived from the bundle receipt:
  they cover every operation in the bundle. The operation's cost is `blockchain.user_operation.gas.cost`. The fee
  histogram of ADR 0020 records it, with an attribute telling operations from transactions.
- **Adapters.** viem: `withHashspan()` also wraps `sendUserOperation` and `waitForUserOperationReceipt` of a
  bundler client. CDP: the smart account factories and every method that sends a user operation, and their waits;
  with a `reader`, the confirm span is completed from the bundle receipt's `UserOperationEvent`.
- **Not in this decision:** EIP-5792 `sendCalls` (its own identifier and status model; viem's fallback for local
  accounts sends transactions without going through the wrapped `sendTransaction`), which gets its own ADR.
  EIP-7702 transactions are already traced as transactions; recording their authorizations is a separate change.

## Consequences

- New attributes under `blockchain.user_operation.*` are added to docs/semconv.md under its change policy; core
  inputs for user operations are new optional members (ADR 0014), so the change is minor.
- The semconv statement that every span has `blockchain.tx.hash` no longer holds for user operation send spans.
- Tests run offline: an EntryPoint deployed on Anvil through the deterministic deployer, and a bundler as an
  external dev-only process (the common bundlers are copyleft; none is a dependency of a published package), plus a
  mock bundler for failure, revert and timeout paths.
- The lab validates it on Base Sepolia, where the canonical EntryPoints are deployed and CDP sponsors operations.

## Implementation notes

- **Core API.** `tracker.startUserOperationSend(input)` returns a send handle whose `end({ userOpHash })` registers
  the link, and `tracker.startUserOperationConfirm({ chainId, userOpHash })` a confirm handle whose `end(receipt)`
  takes a user operation receipt. Every receipt field is optional, for SDKs that report less, and checked like
  payment values; `fail(undefined, { errorType })` records an outcome without an error, such as CDP's `failed`.
  User operations have their own link store and confirm registry, with the same bounds as transactions'.
- **Attribute names.** The EntryPoint is `blockchain.user_operation.entry_point` and the number of calls
  `blockchain.user_operation.call_count`. The confirm span also records the receipt's `sender`, `entryPoint` and
  `nonce` (`blockchain.user_operation.nonce`, a decimal string). Sender, EntryPoint and paymaster follow the
  address mode.
- **Metrics.** The attribute that tells operations from transactions is `blockchain.operation.subject`, recorded as
  `user_operation` on all three histograms (send duration includes the bundler and paymaster requests) and absent on
  those of transactions. The outcome from chain data is `blockchain.user_operation.success`.
- **viem.** Background confirmation and `watch()` stay for transactions; a user operation gets a confirm span from
  `waitForUserOperationReceipt`.
- **Tests.** The Anvil test does not use the canonical EntryPoint or an external bundler: the common bundlers (Alto
  is GPL-3.0-or-later) and the EntryPoint package (`@account-abstraction/contracts` depends on
  `@uniswap/v3-periphery`, GPL-2.0-or-later) fail the license check, which covers dev dependencies too. A stand-in
  EntryPoint at the v0.7 address, with the v0.7 user operation hash, nonces and events, and an in-process bundler
  that sends one `handleOps` transaction per operation, run viem's real bundler actions against Anvil, including an
  operation that reverts inside a successful bundle. Not exercised: signature validation, gas accounting and
  prefunds of a real EntryPoint, paymaster contracts, and a bundler's simulation.
