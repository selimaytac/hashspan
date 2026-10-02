# 0022. Call batches of EIP-5792 `sendCalls`

- Status: proposed
- Date: 2026-10-03

## Context

EIP-5792 lets an app hand a wallet a batch of calls with `wallet_sendCalls`. The wallet returns a batch id, not a
transaction hash, and reports the outcome later through `wallet_getCallsStatus`: a status code (100 pending, 200
confirmed, 4xx failed off chain without inclusion, 5xx reverted, 6xx partially reverted), whether the batch ran
atomically, and the receipts of the transactions that carried it. A wallet may run the calls in one transaction, in
several, or in a user operation whose bundle transaction also carries other operations. Nothing traces this today,
and ADR 0021 left it to its own decision.

From viem 2.57.2 (source reading, checked where noted):

- The wallet client has `sendCalls`, `sendCallsSync`, `getCallsStatus`, `waitForCallsStatus` and `showCallsStatus`.
  `waitForCallsStatus` polls `getCallsStatus`, and dedupes concurrent waits by client `uid` and id.
- `sendCallsSync` calls `sendCalls` and `waitForCallsStatus` through `getAction` on the client it was created with,
  so it does not reach actions that `withHashspan()` wraps (checked with a test).
- With `experimental_fallback`, a failed `wallet_sendCalls` makes viem send each call as a plain transaction from
  the account, calling `sendTransaction` directly, so the wrapped `sendTransaction` does not see them. The returned id
  is then the transaction hashes (a zero hash for a call that failed to send), the chain id and a magic suffix, and
  `getCallsStatus` answers it from `eth_getTransactionReceipt`. Checked on Anvil 1.8.3, which answers
  `wallet_sendCalls` with -32601: the fallback sends the transactions, and the status has full receipts, with
  `effectiveGasPrice`.
- `waitForCallsStatus` with `throwOnFailure` rejects with `BundleFailedError`, which carries the status; with a
  custom `status` predicate it can resolve while the batch is still pending.

## Decision

- **A call batch is identified by its chain and the id the wallet returned.** Its spans are `send {chainId}` and
  `confirm {chainId}`, like a transaction's and a user operation's, so agent traces read the same. The confirm span
  is keyed in a third key space, apart from transactions and user operations, so ADR 0007 holds.
- **The send span** covers `sendCalls` until the id is returned; ADR 0015 applies. It records the batch id, the
  account as sender, and the number of calls; no `blockchain.tx.hash` and no `blockchain.tx.from` (the transaction's
  sender may be a bundler or relayer). Per-call function names and arguments are not recorded.
- **The confirm span** ends with the status the caller's wait returned. It records the status code, whether the
  batch ran atomically, the hashes of the receipts' transactions, and the block number of the last receipt.
- **Outcomes, from the status code**: 2xx is success; 4xx ends with error status and `error.type` `failed` (nothing
  was included, so no chain data; ADR 0016); 5xx with `reverted`; 6xx with `partially_reverted`. A
  `BundleFailedError` is mapped from the status it carries. A wait that resolves while the status is pending (1xx)
  ends without an outcome and records no confirmation metric; so does a status without a code or with a code
  EIP-5792 does not define (such as 3xx). `WaitForCallsStatusTimeoutError` ends as `timeout`; other errors as a
  failure.
- **Fees** are not recorded on the batch: EIP-5792 receipts need not carry a gas price, and a receipt can be a
  bundle transaction shared with others (as in ADR 0021). The fee histogram records nothing for batches; the send
  and confirmation histograms carry `blockchain.operation.subject` `call_batch`.
- **viem's fallback.** The hashes in a fallback id are the account's own transactions. The adapter records each as
  a transaction sent by the batch: its send key links to the batch send span, and it follows the transaction rules
  from there (background confirmation when enabled, the caller's own waits), so its fee is recorded once, on its own
  confirm span (with ADR 0024). The batch confirm span does not create them. The id format is copied from viem;
  tests run the installed viem's fallback, including a call that fails to send (a zero hash in the id).
- **Wrapped actions**: `sendCalls`, `waitForCallsStatus`, and `sendCallsSync` as one send span and one confirm span:
  viem's `sendCallsSync` runs over a copy of the client that carries the wrapped `sendCalls` and
  `waitForCallsStatus`. An extension applied before `withHashspan()` that replaced `sendCallsSync` itself is then not
  called; one that replaced `sendCalls` or `waitForCallsStatus` still is, since the wrappers call the client's.
  `getCallsStatus` is not wrapped: `waitForCallsStatus` polls it, and a caller polling it gets no confirm span, as with
  `getTransactionReceipt` today. Batches get no background confirmation and no `watch()`: only a wait the caller
  makes records a batch confirm span.
- **Chain.** The send span takes the call's `chain`, else the client's. The wait takes the client's chain, else the
  status's `chainId` once it is known (a late start, as for waits without a chain today).

## Consequences

- New attributes go to docs/semconv.md under its change policy. Their names, confirmed in review:
  `blockchain.call_batch.id` (send, confirm; truncated after 256 characters), `.sender` (address mode),
  `.call_count` (send), `.status_code` (int, confirm), `.atomic` (boolean, confirm) and `.transaction_hashes`
  (string array, confirm).
- Core gets new optional members for batches (ADR 0014): a send handle that registers the batch id and a confirm
  handle that takes a status, with their own bounded link store and confirm registry. The viem adapter detects them
  and leaves batches untraced with an older core.
- Tests run offline: unit tests on the mock transport answering `wallet_sendCalls` and `wallet_getCallsStatus`
  (including 4xx, 5xx, 6xx, pending, `throwOnFailure` and timeout); on Anvil, viem's real fallback with a local
  account, and an in-process stand-in wallet that answers `wallet_sendCalls` with one transaction.
- Wallets that run a batch as a user operation report the bundle transaction's receipt; the batch span then has the
  bundle's hash, and the operation's own cost is not known to the adapter.
- Older viem releases in the peer range had `sendCalls` only as an experimental extension, with a string id and a
  status without a code: their batches get send spans and confirm spans without an outcome.
