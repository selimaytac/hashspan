# 0008. Replaced transactions

- Status: proposed
- Date: 2026-09-27

## Context

A pending transaction can be replaced by another one from the same sender and nonce, for example when a wallet
speeds it up or cancels it. viem's `waitForTransactionReceipt` detects this (`checkReplacement`, on by default
unless the chain opts out) and then resolves with the receipt of the **replacing** transaction. Before resolving,
it calls the caller's `onReplaced` callback with a `reason`, the replaced and replacing transactions and the
receipt; if that callback throws, the wait rejects. viem infers the reason from the replacing transaction's shape:

- `repriced`: same `to`, `value` and `input`; only the fee changed
- `cancelled`: a zero-value transaction from the sender to itself
- `replaced`: anything else

Other libraries report replacements differently (for example by rejecting the wait with an error that carries the
replacing receipt) and may classify them with other heuristics.

The confirm span is started for the original hash, so today the replacing transaction's status, gas and fee are
recorded under the original hash. A cancelled transfer then looks like a successful one.

## Decision

**The receipt belongs to the transaction that was mined.** Status, block, gas, fee and revert reason are only ever
recorded on the confirm span whose `blockchain.tx.hash` equals the receipt's transaction hash.

**Enforced by the core.** `ReceiptLike` gains two optional fields: `transactionHash` and `replacementReason`
(`repriced` | `cancelled` | `replaced`). When a confirm handle ends with a receipt whose `transactionHash` differs
from the confirm hash (compared case-insensitively), the tracker:

1. ends the original confirm span as replaced (below);
2. records the receipt on the confirm span of the mined hash in the confirmation registry (ADR 0007): it ends an
   in-flight span for that hash, does nothing if that hash already settled, and otherwise creates one.

Adapters only pass the receipt and, when the library reported it, the reason. Every adapter gets the same
attribution without comparing hashes itself. Receipts without `transactionHash` keep today's behaviour.

**Original transaction.** Its confirm span ends with:

- `blockchain.tx.status = replaced`, for all three reasons; there is no separate `cancelled` status
- `blockchain.tx.replacement.hash`: hash of the mined transaction
- `blockchain.tx.replacement.reason`: the reason reported by the instrumented library; omitted when none was
  reported. The adapter never infers a reason itself.
- no block number, gas, fee or revert reason
- span status unset and no `error.type`: a repriced transaction usually continues what was intended, and only the
  application knows whether a cancellation is a failure

**Mined transaction.** When the tracker creates its confirm span, it has the same parent and start time as the
original confirm span, so its duration covers the whole wait. It links to the original confirm span, to the
original send span when known, and to its own send span when it was sent through the same tracker. Links are set
when the span is created. The usual status rules apply (`success`, or `reverted` with error status).

**Validation.** `blockchain.tx.replacement.hash` is recorded only if it is a 32-byte hex string and
`blockchain.tx.replacement.reason` only if it is one of the three values; anything else is dropped. Both then pass
through the redaction hook like every attribute, and are kept when the hook fails, like the transaction hash.

**viem adapter.**

- It wraps `onReplaced`: it stores the replacement first, then calls the caller's callback with the same argument.
  What the callback throws still rejects the wait, as in plain viem, and the stored replacement is still recorded.
  Recording never throws into the caller.
- `checkReplacement` is passed through unchanged. With `checkReplacement: false` viem does not detect
  replacements, and neither does the adapter.
- The caller still receives viem's result, the mined transaction's receipt.
- The revert reason of a reverted replacing transaction is decoded with the ABI recorded for the mined hash, else
  with the original `writeContract` ABI when both transactions call the same contract (addresses compared
  case-insensitively). Errors are matched by selector, so another ABI of the same contract only misdecodes on a
  selector collision.

**Semantic conventions.** `docs/semconv.md` gains the `replaced` value of `blockchain.tx.status`, the two
`blockchain.tx.replacement.*` attributes (on by default) and a *Span status* row: replaced, confirm, unset, no
`error.type`, `replaced`.

## Consequences

- Fees and outcomes are attributed to the hash that paid them, so cost queries by hash stay correct.
- A replacement yields two confirm spans. Dashboards that count confirmations should exclude
  `blockchain.tx.status = replaced`, which also avoids counting the wait twice.
- Classifying replacements as failures (for example cancellations) is left to the application, for example through
  queries or span processors on `blockchain.tx.replacement.reason`.
- The reason is the library's heuristic. A replacement that only looks like a cancellation is reported as
  `cancelled`.
- No new tracker or handle methods: user-implemented trackers keep working and simply ignore the new optional
  receipt fields.
