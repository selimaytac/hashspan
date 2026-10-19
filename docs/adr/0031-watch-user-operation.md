# 0031. Confirming a user operation sent elsewhere

- Status: accepted
- Date: 2026-10-19

## Context

`watch()` confirms a transaction sent outside the extended clients (ADR 0012). Some senders return only a hash of a
user operation they sent for a smart account:

- a smart account SDK's `sendTransaction` (permissionless.js, ZeroDev) returns the bundle transaction's hash once
  the operation is included (ADR 0021 amendment, #430);
- a hosted wallet, such as Coinbase Agentic Wallets (`awal`), sends the operation in its own process and returns
  the bundle transaction's hash, or the user operation hash when it has no bundle hash yet.

`watch()` on a bundle hash records the bundle transaction: the bundler's sender, the bundle's status and the fee of
every operation in the bundle, which ADR 0021 says a user operation's spans must not carry. On a user operation hash
it finds no receipt. A user operation has no confirm span in either case.

What the chain gives: the bundle receipt holds one `UserOperationEvent(userOpHash, sender, paymaster, nonce, success,
actualGasCost, actualGasUsed)` per operation, with `userOpHash`, `sender` and `paymaster` indexed, the same for
EntryPoint 0.6 to 0.9. Any contract can emit a log with that signature, and one bundle can carry several operations
of one sender. A bundler answers `eth_getUserOperationReceipt` for a user operation hash; a node does not.

## Decision

**API.** A new member of `HashspanExtension`, `watchUserOperation(client, options)`, additive and so minor
(ADR 0014, ADR 0027). Like `watch()`, it never throws and never waits, `flush()` awaits it, and the confirm span is
the user operation confirm span of ADR 0021: keyed by chain and `userOpHash`, linked to the send span when the same
tracker recorded one, its parent the span active at the call. Two inputs:

- `{ userOpHash }`: the receipt comes from a bundler, `eth_getUserOperationReceipt`.
- `{ bundleHash, sender, nonce? }`: the operation is read from the bundle transaction's receipt,
  `eth_getTransactionReceipt`, and matched by its `UserOperationEvent`. `userOpHash` may be given as well, to match
  on it too.

Both take `chainId` and `timeoutMs` as `watch()` does: the chain defaults to the client's, a mismatch records nothing
with a `diag` warning, a client without a chain is asked with `eth_chainId`, and polling stops after `timeoutMs`
(default 120 000 ms). Each is one of the background confirmations of ADR 0018: over `maxBackgroundConfirmations`,
nothing is recorded and no request is made.

**Requests.** Through `client.request` only, never a client action: an action of a client extended by
`withHashspan()` would record a transaction confirm span for the bundle. A failed request or a missing receipt is
polled again, every `pollingInterval` of the client (1000 ms without one), until the timeout.

- With `userOpHash` alone, the client must be a bundler client: one with viem's bundler actions as own functions
  (`createBundlerClient`, or a smart account SDK's client). Any other client records nothing and gets no request,
  with a `diag` warning. A node's logs are not searched for the hash.
- With `bundleHash`, any client of the chain's node.

**Matching in a bundle receipt.** The receipt's `transactionHash` must be the `bundleHash`. Of its logs, only those
whose first topic is the `UserOperationEvent` signature, emitted by the contract the bundle transaction called (its
`to`) or by a canonical EntryPoint 0.6 to 0.9, count; this is the rule `@hashspan/cdp` uses since #458. Of those, the
`sender` topic must be the sender, the decoded `nonce` the nonce when one is given, and the `userOpHash` topic the hash
when one is given.

- **One match** opens the confirm span at the call's time and ends it with the event's `success`, `actualGasCost`,
  `actualGasUsed`, `sender`, `nonce`, `paymaster` and EntryPoint, and the bundle's hash and block. The fee sample has
  `blockchain.operation.subject` `user_operation`. No `blockchain.tx.status` or `blockchain.tx.fee` (ADR 0021).
- **No match, or more than one** records no span, with a `diag` message. The confirm span is keyed by the
  `userOpHash`, which only the matched event gives; picking one of several would record one operation's outcome under
  another's key. This is the "no outcome" of the #443 recommendation: with no key, there is no span to end as
  `_OTHER`. A `nonce` tells several operations of one sender apart.
- **Bound.** A receipt with more than 10 000 logs is not matched at all, and records no span: reading only the first
  10 000 could find one match while a second lies past the bound (ADR 0025 rule 4). Topics and the emitter are
  compared before any log is decoded.

**Outcomes.**

| Input | Outcome | Span |
|---|---|---|
| `userOpHash` | receipt | ends with the receipt, as `waitForUserOperationReceipt` records it; `success` `false` is `reverted` |
| `userOpHash` | receipt for another `userOpHash` | ends with `error.type` `_OTHER`, no receipt data |
| `userOpHash` | no receipt by the timeout | ends as `timeout` (ADR 0016) |
| `bundleHash` | one matching event | opened and ended with the event, as above |
| `bundleHash` | no receipt by the timeout, a receipt of another hash, no or several matching events, more logs than the bound | none |
| either | invalid input, a mismatched chain, the limit reached, not a bundler client for `userOpHash` | none, no request |

The asymmetry is the key: with a `userOpHash` the span exists from the call, so giving up is an outcome of it; with a
`bundleHash` alone, no key exists until a single event names one.

**Not in this decision.**

- A send span. Only the sender can record one, with the same tracker.
- Revert reasons from `UserOperationRevertReason` on the bundle path (as in `@hashspan/cdp`); the bundler path records
  the reason the bundler returns, as `waitForUserOperationReceipt` does.
- Searching a node's logs for a `userOpHash` (`eth_getLogs`), which needs a block range and has provider limits.
- Telling a bundle hash from a user operation hash: both are 32 bytes, and the caller says which one it has.
- Re-reading the receipt after a reorganisation (ADR 0026), and a sealed receipt after a preconfirmation (ADR 0024):
  the event's values are the operation's own, not the bundle's fees, and are recorded as read.
- An `onReceipt` callback like `watch()`'s.

## Consequences

- A user who has only a bundle hash and the smart account's address, or a user operation hash and a bundler, gets the
  operation's own confirm span: outcome, cost and paymaster, not the bundler's transaction.
- The matcher is a copy of `@hashspan/cdp`'s, inside `@hashspan/viem`, since cdp imports only the public API of
  `@hashspan/viem` and exporting a matcher would freeze it (ADR 0027). A test keeps both copies' canonical EntryPoints
  equal to viem's list and their results equal on shared receipts.
- Several operations of one sender in one bundle record nothing without a `nonce`. Hosted wallets that do not return
  the nonce cannot be confirmed in that case.
- Whether a given hosted wallet's hash is a bundle hash, and which EntryPoint it uses, is the wallet's choice and can
  change; docs/integrations.md states what is covered and what was not tested.
