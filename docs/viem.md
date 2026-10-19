# @hashspan/viem reference

The details of [`@hashspan/viem`](../packages/viem/README.md) that its README links to: how each feature behaves at
its edges, what it costs in requests, and the limits of single features. Start with the README; each section here
has the name of the README section it continues.

## Transactions sent elsewhere

Options of `watch()`: `chainId` (defaults to the client's chain; without either, when either is not a positive safe
integer, or when it contradicts the client's chain, nothing is recorded and a `diag` message says why; a client
without a chain is asked for its chain id with `eth_chainId` first), `timeoutMs` (default 120 000 ms), `abi`, to
decode custom errors in the revert reason, and `onReceipt`, called once when the watch ends with the receipt of the
mined transaction, or with `undefined` when none was retrieved; it never affects the confirm span. A `hash` that is
not a 32-byte hex hash records nothing and sends no request: `onReceipt` is called with `undefined`. `watch()` never
throws or waits; `flush()` awaits the confirmation, not the callback.

The confirm span's parent is the span active when `watch()` is called. Without one, it is the send span's parent when
the same tracker sent the transaction; otherwise, as for a hash sent by another tracker or by something untraced, the
confirm span is in a trace of its own, with no send span and no link
([confirm span parent](semconv.md#spans)).

## Shutting down

`flush()` resolves `true` when all pending work finished and `false` on timeout; it never rejects, and it keeps the
process alive while it waits. On timeout, confirm spans still waiting are ended and exported: with the receipt if
only the revert reason or the OP Stack operator fee was still pending (without them), without fees if only the
sealed receipt was, otherwise as an error with `error.type` `timeout`. Background confirmations keep polling until
their own `timeoutMs`, so short-lived processes should keep that short. The timeout also ends the spans of your own
`waitForTransactionReceipt` calls that are still waiting, and a receipt they return later is not recorded: call
`flush()` only when the process is shutting down. Long-running services do not need `flush()`.

## Background confirmation

- Each transaction gets one confirm span per tracker. If the caller also waits for the receipt on a client
  extended with the same tracker, both waits share that span: a receipt from either ends it, and a background
  timeout does not end it while the caller is still waiting. A wait without a timeout (`timeout: 0`) for a
  transaction that is never mined therefore keeps the span open.
- Polling adds RPC requests to your provider (one receipt request per polling interval until the receipt arrives).
  It polls independently of your own `waitForTransactionReceipt` calls, so your `timeout`, `confirmations` and other
  options always apply to your wait; while both run, receipt requests are made for each.
- Background confirmation and `watch()` wait for one confirmation and record `blockchain.tx.wait.confirmations` `1`.
  The span records the count of the wait that ended it, and the background wait usually gets the receipt first: your
  own wait with `confirmations: 12` for the same transaction then adds nothing to it
  ([one confirm span per transaction](semconv.md#spans)).
- A pending confirmation keeps the Node.js process alive until the receipt arrives or `timeoutMs` (default
  120 000 ms) passes; the span then ends as an error with `error.type` `timeout`.
- viem's `waitForTransactionReceipt` fails on the first failed request of its poll (a rate limit, a JSON-RPC error,
  a request timeout, a connection reset), and with `TransactionReceiptNotFoundError` when a node returns a mined
  transaction before its receipt. Background confirmation and `watch()` then wait one polling interval and poll
  again, until `timeoutMs`: the span ends as `timeout` only if no receipt came, and a provider that keeps failing
  holds the confirmation (and its place under `maxBackgroundConfirmations`) until then. Your own waits are passed on
  unchanged, including these errors.
- At most `maxBackgroundConfirmations` (default 256) background confirmations, including those of `watch()` and
  `watchUserOperation()`, poll at once. A transaction sent while that many are polling gets no background confirm
  span, and a `diag` warning is logged; `0` turns background confirmation off. Your own waits are not counted. See
  [ADR 0018](adr/0018-background-confirmation-limit.md).
- In serverless runtimes that freeze after the response, background confirmations may not complete.

## Revert reasons

A receipt only says that a transaction reverted. For reverted transactions the adapter replays the transaction with
`eth_call` on the previous block's state (and, if that does not revert, as when the contract was created earlier in
the same block, once more on its own block) and records the decoded reason as `blockchain.tx.revert.reason`:
`Error(string)` messages, `Panic` codes, and custom errors when the ABI is known (transactions sent with
`writeContract`), otherwise the error selector. To look up an error message by hand, use the
[error decoder](https://hashspan.dev/errors/decode).

- Two extra RPC requests per reverted transaction (three when the second replay is needed); none for successful ones.
- Best effort: the replay can differ when earlier transactions in the same block changed the state, and providers
  without historical state cannot replay. The reason is then missing.
- `waitForTransactionReceipt` returns as soon as the receipt is available; the confirm span ends once the reason
  has been fetched.
- The replay is bounded: if the provider has not answered within 10 s (`decodeRevertReason: { timeoutMs }`), the
  receipt is recorded without a reason and the confirm span ends.
- Turn it off with `withHashspan({ decodeRevertReason: false })`.

## Clients without a chain

Prefer clients with a `chain`. For a client without one, the adapter asks the node for its chain id alongside each
traced call, never before it, and records the span once the answer arrives, with the call's start and end time:

- The call is never delayed or failed by that request. If it fails, or has not answered 30 s after the call ended,
  that call is not traced.
- The chain id is asked for on every call, so spans follow a wallet that switches networks (one extra `eth_chainId`
  per traced call).
- These spans have millisecond precision and are exported shortly after the call ends.
- RPC or HTTP spans of the call do not nest under the send span, since it does not exist yet while the call runs.

## Replaced transactions

A pending transaction can be sped up or cancelled by sending another one with the same nonce. viem then resolves
`waitForTransactionReceipt` with the receipt of the replacing transaction. hashspan records that receipt on the
confirm span of the transaction that was mined, and ends the confirm span of the awaited hash with
`blockchain.tx.status = replaced`, `blockchain.tx.replacement.hash` and `blockchain.tx.replacement.reason`
(`repriced`, `cancelled` or `replaced`, as viem classifies it). Fees and status therefore always belong to the hash
that paid them.

- Your `onReplaced` callback is called unchanged, and your wait still resolves with viem's result. If your callback
  throws, the wait rejects with its error as in plain viem; the replacement is recorded anyway.
- viem detects a replacement only after its wait has read the original transaction. A replacement sent right after
  the original, before the wait read it, takes it out of the node's pool unseen, and viem's wait times out
  ([wevm/viem#5242](https://github.com/wevm/viem/issues/5242)). hashspan then looks for the replacement itself, for
  a transaction sent through the same `withHashspan()` result: it records it as above, without
  `blockchain.tx.replacement.reason`, as viem reported none. It knows the sender and nonce from your call, or, when
  you pass no `nonce` or send a signed transaction, from one `eth_getTransactionByHash` it sends through the sending
  client right after the send, off your call's path; not through an EIP-1193 provider (`custom()`), such as a wallet
  service's, which hashspan sends nothing. It searches the last 128 blocks, with at most 13 requests after
  the timeout; your wait still rejects with viem's `WaitForTransactionReceiptTimeoutError`, and both confirm spans
  end when it did.
- `checkReplacement: false` turns off viem's detection, and with it this attribution.
- A replaced transaction is not an error: whether a cancellation is a failure is up to your application.

## Preconfirmed receipts (flashblocks)

Some RPC nodes, such as Base's, answer `eth_getTransactionReceipt` before the block is sealed, with a receipt whose
block hash is zero. Its status, block and gas are those of the sealed receipt, but its L1 fee can be another
transaction's. hashspan therefore records fees from the sealed receipt:

- A receipt with a zero or null block hash is treated as a preconfirmation. The adapter reads the receipt again,
  off your call's path, once per polling interval (1 s without one), for at most 30 s and never past a background
  confirmation's `timeoutMs`, and records the sealed receipt. The span keeps the time the preconfirmation arrived as
  its end time.
- If no sealed receipt comes in time, or `flush()` cannot wait for it, the span records the preconfirmation without
  `effective_gas_price`, `l1_fee` and `fee`, since a fee without its L1 part would look valid and be too low.
- Your `waitForTransactionReceipt` still returns what the node returned, and `watch()`'s `onReceipt` gets the receipt
  viem resolved with.
- See [ADR 0024](adr/0024-sealed-receipt-fees.md).

## OP Stack operator fee

OP Stack chains after the Isthmus upgrade can charge an operator fee on top of the execution and L1 fees. A node adds
`operatorFeeScalar` and `operatorFeeConstant` to the receipt when the chain charges one; viem passes them on
unformatted. Only for such a receipt, and only from the sealed receipt, the adapter makes one `eth_call`, off your
call's path, to the GasPriceOracle's `getOperatorFee(gasUsed)` at the receipt's block, through the client that read
the receipt, and records the result as `blockchain.tx.operator_fee`. `blockchain.tx.fee` and the fee histogram do not
include it. A receipt without the fields, as on Base and OP Mainnet while their operator fee is zero, costs no
request. If the call fails, answers with something other than one `uint256`, or takes longer than 10 s, the receipt
is recorded without it. The span keeps the time the receipt arrived as its end time.

## Fees paid in a token

On Celo, a transaction with a `feeCurrency` pays gas in that token, and on Tempo every transaction pays in a fee
token, a plain EIP-1559 one as well as one of Tempo's type `0x76`. The fee attributes are recorded as the receipt
gives them, never converted, and the confirm span names the token in `blockchain.tx.fee_asset` (under the address
mode), while the fee sample carries `blockchain.fee.denomination` `token`. The adapter reads Celo's `feeCurrency`
from the arguments of `sendTransaction`, `writeContract` and their sync forms, and Tempo's `feeToken` from a receipt
whose type is `0x76`, or of another type that also names a `feePayer`, as Tempo's receipts all do; it imports no
chain module and makes no request for either. A transaction sent with `sendRawTransaction`, or sent elsewhere and
confirmed with `watch()`, records no Celo fee currency, since only the transaction names it
([ADR 0028](adr/0028-fee-asset.md)).

## Tempo transactions

- **Sponsored fees.** Only a Tempo transaction of type `0x76` can have its fee paid by another account, which its
  receipt names in `feePayer`. When it is a valid address other than the receipt's `from`, the fee sample carries
  `blockchain.fee.payer` `sponsor`, so it is not counted as the sender's fee; no address is recorded on the sample or
  the span ([ADR 0020](adr/0020-metrics.md)).
- **Pending receipts.** A Tempo multisig relay (`Relay.multisig` of `viem/tempo`) answers a sync send whose approvals
  are below quorum with a receipt whose `status` is `pending` (or none, without viem's Tempo formatter) and whose hash
  is the multisig operation's. The send span ends when the call returns, as usual. A pending receipt is no outcome: it
  withdraws the wait, as a timeout does and as a pending call batch does, so the confirm span ends without an outcome,
  error or metric sample when no other wait of the hash is running, and no request is made. A wait that resolves
  with one does the same.
- **Following a multisig operation.** With `followMultisigOperations`, the confirm span of such a sync send keeps
  waiting off your call's path: the adapter asks for the operation's receipt with `eth_getTransactionReceipt`, spread
  over the option's `timeoutMs` (default 120 000 ms), at most 60 times and never more often than the client's polling
  interval. Through a remote relay (`withRelay(http(), http(relayUrl))`), each poll that finds nothing costs 3 JSON-RPC
  requests: the receipt from the default node, `multisig_getOperation` and the receipt from the relay. When the relay
  has submitted the transaction, its receipt names the operation under `multisig` and is recorded on the span, which
  keeps the operation's hash; otherwise the span ends as `timeout`. The follow counts towards
  `maxBackgroundConfirmations` and `flush()` ends it; when the limit is reached, or is `0`, nothing is followed and
  the span ends without an outcome, as without the option
  ([ADR 0018](adr/0018-background-confirmation-limit.md)).
  With the option, your own `waitForTransactionReceipt` of the operation's hash records the submitted transaction's
  receipt the same way.

## Smart accounts (ERC-4337)

- The send span covers preparing, signing and handing the operation to the bundler, and is the active span while
  that runs, so spans that your RPC or HTTP instrumentation creates for the bundler and paymaster requests nest under
  it. It records the smart account, EntryPoint, number of calls and user operation hash, and no `blockchain.tx.*`
  attribute.
- The confirm span records the operation's success, gas used and cost (`actualGasCost`), nonce (a decimal string)
  and paymaster, and the bundle transaction's hash and block. An operation whose calls reverted ends with
  `error.type` `reverted` and its decoded revert reason, even though the bundle transaction succeeded. The bundle
  transaction's status and fee are not recorded: they cover every operation in the bundle. The fee histogram records
  the operation's cost
  ([ADR 0021](adr/0021-user-operations.md)).
- The chain id is the bundler client's, which `createBundlerClient` takes from its `client`; without one, the spans
  are recorded once the bundler answered `eth_chainId`, as for [clients without a chain](#clients-without-a-chain).
- Only these two bundler actions are traced; viem calls the others from inside them. Background confirmation and
  `watch()` cover transactions only: a user operation gets a confirm span when you wait for its receipt, or from
  [`watchUserOperation()`](#user-operations-sent-elsewhere).

### Smart account SDKs

The smart account clients of permissionless.js (`createSmartAccountClient`) and ZeroDev (`createKernelAccountClient`)
are bundler clients with `sendTransaction`, `writeContract` and, in permissionless, `sendCalls` on top. These send a
user operation through the client the SDK added them to, wait for its receipt and return the bundle transaction's
hash, so `withHashspan()` applied to the finished client does not see the operation:

- On such a client, `sendUserOperation` and `waitForUserOperationReceipt` are traced as above.
- A `sendTransaction`, `writeContract` or `sendCalls` whose account (the call's, else the client's) is a smart
  account is not traced, with a `diag` warning: it sends no transaction and no call batch, and the hash it returns is
  the bundle's, whose status and fee belong to the bundler. Their sync forms are not traced either.
- For user operation spans from those actions, apply `withHashspan()` before the SDK's actions:
  `createBundlerClient(...).extend(withHashspan()).extend(smartAccountActions)` with permissionless
  ([setup](integrations.md#smart-account-sdks)).
  The returned hash is the bundle transaction's: a wait for it on a traced client records the bundle transaction,
  not the operation. `watchUserOperation()` with that hash and the smart account's address records the operation
  ([below](#user-operations-sent-elsewhere)).

### User operations sent elsewhere

- **With `bundleHash` and `sender`**, a client of the chain's node, such as a public client, reads the bundle receipt
  (`eth_getTransactionReceipt`; a bundler client would ask its bundler), and the operation is its one
  `UserOperationEvent` with that `sender` topic, emitted by the contract the bundle transaction called or by a
  canonical EntryPoint (0.6 to 0.9); events of other contracts do not count. Give `nonce` when the sender can have
  more than one operation in a bundle: with several matches and no nonce, nothing is recorded. Give `userOpHash` too
  when you know it, and the event must carry it. No match, a receipt of more than 10 000 logs, or no receipt by
  `timeoutMs` record nothing, with a `diag` message: the operation's hash, which keys its span, is only known from
  the event. A user operation hash given as `bundleHash` has no transaction receipt: it is polled until `timeoutMs`,
  in a slot of `maxBackgroundConfirmations`, and records nothing.
- **With `userOpHash` alone**, the client must be a bundler client (one with viem's bundler actions, such as
  `createBundlerClient`'s or a smart account SDK's); it is polled with `eth_getUserOperationReceipt`. Any other client
  records nothing and gets no request. No receipt by `timeoutMs` ends the span as `timeout`.
- Options as for `watch()`: `chainId` (defaults to the client's chain, or for a bundler client to that of its
  `client`) and `timeoutMs` (default 120 000 ms). It counts as one of the `maxBackgroundConfirmations`, sends its
  requests with the client's `request`, not its actions, so a client extended by `withHashspan()` records no
  confirm span of the bundle transaction, never throws or waits, and `flush()` awaits it.
- There is no send span unless you record the call that sends with the same tracker. Revert reasons are recorded
  only from a bundler's receipt
  ([ADR 0031](adr/0031-watch-user-operation.md)).

## Call batches (EIP-5792)

- The send span covers handing the batch to the wallet, and records the account, number of calls and batch id.
- The confirm span records the outcome (`blockchain.call_batch.status`: `success` for 200, `reverted` for 500,
  `partially_reverted` for 600), the status code, whether the batch ran atomically, the hashes of the transactions
  that carried it, and the highest block among its receipts. A status 400 ends with `error.type` `failed`, any other
  code with `_OTHER`; a wait that accepts a pending status ends without an outcome. No fee is recorded: wallet
  receipts lack the L1 fee and can be a bundle transaction shared with others. Batch ids must be `0x`-prefixed hex;
  others are not recorded.
- With `experimental_fallback`, viem sends the calls as plain transactions when the wallet lacks `wallet_sendCalls`.
  Each is confirmed as a transaction linked to the batch's send span, as `watch()` does, so its receipt and fee are
  recorded whether or not background confirmation is on. Each of these confirmations polls until `confirm.timeoutMs`
  (120 000 ms by default, also without background mode) and counts toward `maxBackgroundConfirmations`. At most 64
  transactions of a batch are confirmed this way
  ([bounds](semconv.md#bounds)).
- `sendCallsSync` records one send span and one confirm span: viem's own `sendCallsSync` runs with the traced
  `sendCalls` and `waitForCallsStatus`, so an extension applied before this one that replaces `sendCallsSync` itself
  is not called ([apply it last](../packages/viem/README.md#apply-it-last)). This needs viem 2.45.2 or later: from
  2.38.0 to 2.45.1, viem's `sendCallsSync` calls the two actions directly, so the batch is sent and waited for
  untraced, with its result unchanged. `getCallsStatus` is not traced: polling it yourself records nothing, as with
  `getTransactionReceipt`. Background confirmation and `watch()` do not cover batches.
- See [ADR 0022](adr/0022-call-batches.md).

## JSON-RPC requests

- Spans follow the OpenTelemetry RPC conventions: `rpc.system.name` `jsonrpc`, `rpc.method`,
  `jsonrpc.protocol.version`, and `server.address` and `server.port` from the transport's URL, plus
  `blockchain.chain.id`. No parameters or results are recorded, and of the URL only the host and port, since the
  path often holds an API key. The host is recorded as it is: with a provider that gives each endpoint its own
  subdomain, it identifies your endpoint. These spans do not pass through the tracker's `redact` hook; to leave the
  host out, drop `server.address` in a span processor or a collector rule.
- A failed request ends with error status and `error.type`: its JSON-RPC error code (also `rpc.response.status_code`)
  or the error's class name, never the message.
- `methods` chooses which methods get a span (default: all); the README's example leaves out receipt polling.
  `tracerProvider` replaces the global tracer provider.
- See [ADR 0019](adr/0019-json-rpc-spans.md).

### Trace context for the provider

- Off unless you pass it. It sends `traceparent`, and `tracestate` when the trace has one, never `baggage`; it does
  not use the global propagator. The trace id, span id and sampled flag reach your provider.
- Use it or an HTTP instrumentation of `fetch` (such as `@opentelemetry/instrumentation-undici`), never both: the
  instrumentation adds a second `traceparent` header that the hook cannot see. A request that already has a
  `traceparent` header keeps it.
- A request gets a header only inside its JSON-RPC span: wrap the transport in `traceTransport()`, and a method that
  `methods` leaves out gets none. With `batch: true`, an HTTP request of several JSON-RPC requests gets none, since
  they can belong to different traces.
- Needs viem 2.21.25 or later; with an older viem it sends nothing and logs a `diag` warning. To keep a hook of your
  own, call this one from it and return its result.
- An eRPC setup: [RPC gateways](integrations.md#rpc-gateways-erpc).
  See [ADR 0030](adr/0030-trace-context-on-json-rpc-requests.md).

## Known limits

The limits of single features; the README lists the
[general ones](../packages/viem/README.md#known-limits).

- A transaction replaced before viem's wait read it still ends its confirm span with `error.type` `timeout` when the
  replacement was mined before the last 128 blocks, when it was sent without a `nonce` and the replacement reached
  the node before hashspan's read of the sent transaction (the node then no longer knows it), when that read fails,
  and when it was sent elsewhere and confirmed with `watch()` ([replaced transactions](#replaced-transactions)).
- Through an EIP-1193 provider (`custom()`, such as a wallet service's), a send without a `nonce` is not read, so a
  replacement sent right after it ends its confirm span with `error.type` `timeout`; pass `nonce` to have it found.
- A send without a `nonce`, and a raw send, cost one `eth_getTransactionByHash` through the sending client, for the
  replacement search above, unless the client sends through an EIP-1193 provider; pass `nonce` to avoid it.
- A wait that resolves with the receipt of another transaction that viem did not report as a replacement, as after a
  mixed-up RPC response, ends the confirm span with `error.type` `_OTHER` and records none of that receipt's data;
  the transaction's own outcome is not recorded ([#355](https://github.com/selimaytac/hashspan/issues/355)).
- A Tempo multisig transaction sent with a sync form below quorum gets a confirm span without an outcome, unless
  `followMultisigOperations` is on; its send and confirm spans carry the multisig operation's hash, not the hash of
  the transaction the relay submits later, and a follow costs up to 60 polls, 3 requests each through a remote relay
  ([Tempo transactions](#tempo-transactions)).
- A Tempo transaction (type `0x76`) with a `calls` list has no top-level `to`: its send span records no recipient.
- A preconfirmed receipt whose sealed receipt does not come in time is recorded without fees
  ([preconfirmed receipts](#preconfirmed-receipts-flashblocks)).
- A Celo transaction sent with `sendRawTransaction`, or confirmed with `watch()` without a traced send, records its fee
  in its fee currency without `blockchain.tx.fee_asset` ([fees paid in a token](#fees-paid-in-a-token)).
- With viem older than 2.57.0, concurrent waits on one hash with different counts share viem's first poll, so the
  recorded count may be the other wait's: a wait of 1 that joins a wait of 5 on the same client resolves with it at
  depth 5 and records `blockchain.tx.wait.confirmations` `1`
  ([wevm/viem#5142](https://github.com/wevm/viem/pull/5142)).
- With viem older than 2.33.0, viem's `waitForTransactionReceipt` reads the transaction before its receipt even when
  the transaction is already mined, so background confirmation and `watch()` also send an `eth_getTransactionByHash`
  for a transaction mined before they start.
  With viem older than 2.21.58, a user operation that the bundler refuses because its call reverts, for a call with
  `data` and no `abi`, records `error.type` `ContractFunctionRevertedError`, as viem classifies it there, where newer
  viem gives `ExecutionRevertedError`.
- On a client without a chain, a call is not traced when its `eth_chainId` request fails or has not answered 30 s
  after the call ended ([clients without a chain](#clients-without-a-chain)).
