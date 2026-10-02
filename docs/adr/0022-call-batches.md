# 0022. Call batches of EIP-5792 `sendCalls`

- Status: proposed
- Date: 2026-10-03

## Context

EIP-5792 lets an app hand a wallet a batch of calls with `wallet_sendCalls`. The wallet returns a batch id, not a
transaction hash, and reports the outcome later through `wallet_getCallsStatus`: a status code (the spec defines 100
pending, 200 confirmed, 400 failed off chain without inclusion, 500 reverted completely, 600 reverted partially),
whether the batch ran atomically, and the receipts of the transactions that carried it. The spec bounds ids to 4096
bytes (8194 characters with the leading `0x`), says wallets SHOULD return a batch's status within 24 hours of
`wallet_sendCalls`, and has error 5720 for a duplicate id. A wallet may run the calls in one
transaction, in several, or in a user operation whose bundle transaction also carries other operations. Nothing
traces this today, and ADR 0021 left it to its own decision.

From viem 2.57.2 (source reading, checked where noted):

- The wallet client has `sendCalls`, `sendCallsSync`, `getCallsStatus`, `waitForCallsStatus` and `showCallsStatus`.
  `waitForCallsStatus` polls `getCallsStatus`. It dedupes concurrent waits by client `uid` and id, and runs only the
  first subscriber's `status` predicate: a second wait with another predicate gets the first one's result.
- `getCallsStatus` turns legacy status strings into codes (`CONFIRMED` 200, `PENDING` 100); any other string is
  passed on as it is.
- `sendCallsSync` calls `sendCalls` and `waitForCallsStatus` through `getAction` on the client it was created with,
  so it does not reach actions that `withHashspan()` wraps (checked with a test).
- With `experimental_fallback`, a failed `wallet_sendCalls` makes viem send each call as a plain transaction from
  the account, calling `sendTransaction` directly, so the wrapped `sendTransaction` does not see them. It needs a
  chain (the call's or the client's), and throws only when every call failed to send. The returned id is the
  transaction hashes (a zero hash for a call that failed to send), the chain id and a magic suffix; `getCallsStatus`
  answers it from `eth_getTransactionReceipt`, with status 600 and fewer receipts when a call failed to send. Checked
  on Anvil 1.8.3, which answers `wallet_sendCalls` with -32601: the fallback sends the transactions and the status
  has their receipts. On Base Sepolia (checked 2026-10-03), those receipts are the node's raw receipts, with
  `effectiveGasPrice`, `blockHash` and `l1Fee` as a hex string.
- `waitForCallsStatus` with `throwOnFailure` rejects with `BundleFailedError`, which carries the whole status as
  `result`. It is thrown inside viem's retry (4 retries, 200 to 1600 ms apart), so a failed batch rejects about 3 s
  after its status was first read. With a custom `status` predicate, a wait can resolve while the batch is pending.

Wallets deviate from the spec. The wallet facts below were reported in the review of this ADR, from wallet
documentation and sources; the last row was checked on Anvil. Parsing is therefore lenient, and what is not
understood is recorded as such rather than guessed:

| Wallet | Deviation | What hashspan records |
|---|---|---|
| Porto (relay) | shifted codes: 300, 400, 500 | 300 as `error.type` `_OTHER`, 400 as `failed`, 500 as `reverted`; what Porto means by them is not interpreted |
| MetaMask | a dropped batch is reported as 500 | `blockchain.call_batch.status` `reverted`, although no chain data shows a revert |
| Safe | the id is the `safeTxHash`; receipts repeat one transaction per call | the id is hex, so it is traced; repeated receipts are recorded once |
| Tempo | a third id format | traced only if the id is `0x`-prefixed hex; otherwise the send span has no id and the wait is untraced |
| viem's fallback | a call that failed to send gives status 600 with fewer receipts | `partially_reverted`, although the failed call never reached the chain |

## Decision

- **A call batch is identified by its chain and the id the wallet returned.** Its spans are `send {chainId}` and
  `confirm {chainId}`, like a transaction's and a user operation's, so agent traces read the same. The confirm span
  is keyed in a third key space, apart from transactions and user operations, so ADR 0007 holds.
- **Ids** are traced only when they are `0x`-prefixed hex of at most 8194 characters (the spec's bound); other ids
  leave the send span without an id and the wait untraced. Keys compare case-insensitively, as hashes do. The
  attribute keeps the first 256 characters. A wallet should answer for a batch for 24 hours, but the send link lives
  for the tracker's link TTL (10 minutes by default): a wait started later records a confirm span without a link to
  the send span.
- **The send span** covers `sendCalls` until the id is returned; ADR 0015 applies. It records the batch id, the
  account as sender, and the number of calls; no `blockchain.tx.hash` and no `blockchain.tx.from` (the transaction's
  sender may be a bundler or relayer). Per-call function names and arguments are not recorded.
- **The confirm span** ends with the status the caller's wait returned. It records the status code as reported, the
  outcome, whether the batch ran atomically (as viem reports it: `false` when the wallet omits it; capability checks
  are out of scope), the receipts' transaction hashes and the highest block number among the receipts. The hashes are
  validated one by one, de-duplicated (Safe repeats one per call) and capped at 64.
- **Outcomes** follow ADR 0016: an attribute only for outcomes from chain data, `error.type` for the rest.
  - 200 → `blockchain.call_batch.status` `success`; 500 → `reverted`; 600 → `partially_reverted`. The latter two
    also set error status and `error.type` `reverted` and `partially_reverted`.
  - 400 (nothing was included) → `error.type` `failed`. A wait that gives up → `timeout`. A `BundleFailedError` is
    recorded from the status it carries; its retries are part of the span's duration.
  - Any other code, a non-integer, a string or no code → `error.type` `_OTHER`; an integer code is kept on the span.
  - 100: a wait that resolves while the batch is pending is an observer outcome, like a timeout: it withdraws its
    claim on the shared span, which ends without an outcome and without a metric sample only when it is the last wait
    still running, and the key is released (ADR 0007), so a later wait gets its own span.
- **Metrics.** The three histograms carry `blockchain.operation.subject` `call_batch`, as for user operations. The
  confirmation outcome is `blockchain.call_batch.status` or `error.type` as above; raw status codes never become metric
  attributes. The batch itself records no fee.
- **Fees.** The batch confirm span records none: EIP-5792 receipts are a subset of transaction receipts, without
  `l1Fee`, so on OP-stack chains a fee from them would look valid and be too low, and a receipt can be a bundle
  transaction shared with others (ADR 0021). A wallet that reports only batch-level receipts gets no fees, by design.
  The receipts viem builds for a fallback id do carry the node's `l1Fee`, but they can be flashblocks preconfirmations
  whose `l1Fee` is another transaction's (ADR 0024); fees therefore come only from the transaction path below, where
  the sealed receipt is checked.
- **viem's fallback.** The hashes in a fallback id are the account's own transactions. Each is registered as a send
  of the batch and confirmed through the transaction confirmation path, as `watch()` does, whether or not
  background confirmation is enabled: its receipt is read through the client, off the call path, in `track()`, within
  the background limit (ADR 0018). ADR 0024 and ADR 0005 apply as for any transaction, so each fee is recorded once,
  on the transaction's own confirm span; the cost is one receipt request per fallback transaction. The batch confirm
  span does not create them. The id format is copied from viem; tests run the installed viem's fallback, including a
  call that fails to send.
- **Wrapped actions**: `sendCalls`, `waitForCallsStatus`, and `sendCallsSync` as one send span and one confirm span,
  by running viem's own `sendCallsSync` over a shim client whose `sendCalls` and `waitForCallsStatus` are the wrapped
  ones. An extension applied before `withHashspan()` that replaced `sendCallsSync` itself is then not called; one
  that replaced `sendCalls` or `waitForCallsStatus` still is, since the wrappers call the client's. `getCallsStatus`
  is not wrapped: `waitForCallsStatus` polls it, and a caller polling it gets no confirm span, as with
  `getTransactionReceipt` today. Batches get no background confirmation and no `watch()`: only a wait the caller
  makes records a batch confirm span.
- **Chain.** The send span takes the call's `chain`, else the client's. The wait takes the client's chain, else the
  status's `chainId` once it is known (a late start, as for waits without a chain today).

## Consequences

- New attributes go to docs/semconv.md under its change policy. Their names, confirmed in review:
  `blockchain.call_batch.id` (send, confirm), `.sender` (address mode), `.call_count` (send), `.status` (closed set,
  confirm, also a metric attribute), `.status_code` (int, confirm span only), `.atomic` (boolean, confirm) and
  `.transaction_hashes` (string array, confirm; the first array-valued attribute, which the redaction hook receives
  as an array).
- Core gets new optional members for batches (ADR 0014): a send handle that registers the batch id and a confirm
  handle that takes a status, with their own bounded link store and confirm registry. The viem adapter detects them
  and leaves batches untraced with an older core.
- Wallets that run a batch as a user operation report the transaction that carried it, with logs filtered to the
  operation; its `gasUsed` is wallet-defined. A custom provider that turns `wallet_sendCalls` into
  `sendUserOperation` in the same process records both layers, the batch's spans and the operation's nested under
  them by ADR 0015, in separate key spaces, without linking or suppressing either.
- Tests run offline; no OSI-licensed offline wallet exists. Unit tests on the mock transport cover the id forms, a
  duplicate id (error 5720), every status class and legacy strings, single, many, empty and repeated receipts, a
  missing `atomic` or `chainId`, `throwOnFailure`, timeout, and concurrent waits. On Anvil: viem's real fallback with
  a local account, and an in-process stand-in wallet that answers `wallet_sendCalls`.
- Older viem releases in the peer range had `sendCalls` only as an experimental extension, with a string id and a
  status without a code: their batches end with `error.type` `_OTHER`.
