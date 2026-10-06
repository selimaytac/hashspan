# @hashspan/viem

Trace the transactions your AI agents, or any of your services, send with [viem](https://viem.sh), using
OpenTelemetry.

A viem client extension that reports to [`@hashspan/core`](https://github.com/selimaytac/hashspan/tree/@hashspan/viem@1.0.0/packages/core): each transaction becomes a
`send {chainId}` span inside the active trace, such as your agent's tool call, a request or a job, and each receipt
wait a linked `confirm {chainId}` span with status, gas and fees.

## Install

```sh
npm install @hashspan/viem @opentelemetry/api viem
```

Requires Node.js 22.3 or later. Bring your own [OpenTelemetry SDK and exporter](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/).

## Usage

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

const hashspan = withHashspan();

const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() }).extend(hashspan);
const reader = createPublicClient({ chain: baseSepolia, transport: http() }).extend(hashspan);

// Inside an agent tool, while the framework's span is active:
const hash = await wallet.sendTransaction({ to, value }); // send span
await reader.waitForTransactionReceipt({ hash }); // confirm span, linked to the send span
```

Reuse the same `withHashspan()` result for every client of one agent: the clients then share one tracker, so
confirmations are linked to their sends even when they happen on a different client.

`withHashspan(options)` accepts all [`@hashspan/core` options](https://github.com/selimaytac/hashspan/tree/@hashspan/viem@1.0.0/packages/core#options) (address mode, error messages,
agent identity, redaction hook) plus:

| Option | Default | Description |
|---|---|---|
| `tracker` | new tracker | A tracker from `createTxTracker()`, to share one between adapters; the core options then configure nothing, since they are the tracker's. A tracker from an older `@hashspan/core` records only what that core supports: user operations and call batches are then passed on untraced |
| `confirm` | none | `{ mode: 'background', timeoutMs? }` confirms every sent transaction without an explicit wait |
| `decodeRevertReason` | `true` | Replay reverted transactions to record their revert reason; `{ timeoutMs }` bounds the replay (default 10 000 ms) |
| `maxBackgroundConfirmations` | `256` | Most background confirmations (background mode and `watch()`) polling at once; see [Background confirmation](#background-confirmation) |

Options are read once, from the object's own enumerable properties: options it inherits through a prototype, such as
the getters of a class instance, are ignored
([ADR 0025](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0025-untrusted-input.md)).

## Transactions sent elsewhere

When a transaction is sent by something other than an extended client, such as a wallet API or another library,
`watch()` confirms it through a viem client in the background. The confirm span carries the receipt, revert reason
and fees like any other, and links to a send span recorded by the same tracker:

```ts
const hashspan = withHashspan();
const reader = createPublicClient({ chain: baseSepolia, transport: http() });

const { transactionHash } = await walletApi.send(tx); // not traced by hashspan
hashspan.watch(reader, { hash: transactionHash });
```

Options: `chainId` (defaults to the client's chain; without either, when either is not a positive safe integer, or
when it contradicts the client's chain, nothing is recorded and a `diag` message says why; a client without a chain is asked for its chain id with
`eth_chainId` first), `timeoutMs` (default 120 000 ms), `abi`, to decode custom errors
in the revert reason, and `onReceipt`, called once when the watch ends with the receipt of the mined transaction, or
with `undefined` when none was retrieved; it never affects the confirm span. `watch()` never throws or waits;
`flush()` awaits the confirmation, not the callback.

To get a send span as well, record the call that sends with the core's tracker and give `withHashspan()` the same
tracker (install `@hashspan/core` too, at the minor of `@hashspan/viem`): the send span then covers the call,
including the service's queue and approval steps, and the confirm span links to it.

```ts
const tracker = createTxTracker();
const hashspan = withHashspan({ tracker });
const reader = createPublicClient({ chain: baseSepolia, transport: http() });

const send = tracker.startSend({ chainId: baseSepolia.id, from, to, value });
let hash: `0x${string}`;
try {
  // The API call runs in the send span's context, so its HTTP span nests under the send span.
  ({ transactionHash: hash } = await context.with(send.context, () => walletApi.send(tx)));
  send.end({ hash });
} catch (error) {
  send.fail(error);
  throw error;
}
hashspan.watch(reader, { hash }); // linked to the send span
```

The confirm span's parent is the span active when `watch()` is called. Without one, it is the send span's parent when
the same tracker sent the transaction; otherwise, as for a hash sent by another tracker or by something untraced, the
confirm span is in a trace of its own, with no send span and no link
([confirm span parent](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/semconv.md#spans)).

## Shutting down

Some spans end after the traced call returned: background confirmations, confirmations of reverted transactions,
which wait for the revert reason, confirmations of [preconfirmed receipts](#preconfirmed-receipts-flashblocks),
which wait for the sealed receipt, and waits with `confirmations` above 1, whose receipt is read again once the wait
resolved. In scripts, CLI agents and serverless functions, flush them before
shutting the OpenTelemetry SDK down, or they are lost:

```ts
await hashspan.flush(); // at most 10 s by default: hashspan.flush({ timeoutMs })
await provider.shutdown();
```

`flush()` resolves `true` when all pending work finished and `false` on timeout; it never rejects, and it keeps the
process alive while it waits. On timeout, confirm spans still waiting are ended and exported: with the receipt if
only the revert reason or the OP Stack operator fee was still pending (without them), without fees if only the
sealed receipt was, otherwise as an error with
`error.type` `timeout`. Background
confirmations keep polling until their own `timeoutMs`, so short-lived processes should keep that short. The timeout also ends the spans of
your own `waitForTransactionReceipt` calls that are still waiting, and a receipt they return later is not recorded:
call `flush()` only when the process is shutting down. Long-running services do not need
`flush()`.

`flush()` waits only for the work of its own `withHashspan()` result, even when results share one `tracker`: an app
with several results, or with other hashspan adapters, flushes each of them.

## Revert reasons

A receipt only says that a transaction reverted. For reverted transactions the adapter replays the transaction with
`eth_call` on the previous block's state (and, if that does not revert, as when the contract was created earlier in
the same block, once more on its own block) and records the decoded reason as `blockchain.tx.revert.reason`:
`Error(string)` messages, `Panic` codes, and custom errors when the ABI is known (transactions sent with
`writeContract`), otherwise the error selector.

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
- See [ADR 0024](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0024-sealed-receipt-fees.md).

## OP Stack operator fee

OP Stack chains after the Isthmus upgrade can charge an operator fee on top of the execution and L1 fees. A node adds
`operatorFeeScalar` and `operatorFeeConstant` to the receipt when the chain charges one; viem passes them on
unformatted. Only for such a receipt, and only from the sealed receipt, the adapter makes one `eth_call`, off your
call's path, to the GasPriceOracle's `getOperatorFee(gasUsed)` at the receipt's block, through the client that read
the receipt, and records the result as `blockchain.tx.operator_fee`. `blockchain.tx.fee` and the fee histogram do not
include it. A receipt without the fields, as on Base and OP Mainnet while their operator fee is zero, costs no
request. If the call fails, answers with something other than one `uint256`, or takes longer than 10 s, the receipt
is recorded without it. The span keeps the time the receipt arrived as its end time.

## Background confirmation

Some agent frameworks wait for receipts through their own client, or never wait at all. With
`confirm: { mode: 'background' }`, every transaction sent through the extended client gets a confirm span anyway:
the adapter polls for the receipt through the sending client and records the result. The send call is not
delayed.

```ts
const wallet = createWalletClient({ account, chain, transport: http() }).extend(
  withHashspan({ confirm: { mode: 'background', timeoutMs: 60_000 } }),
);
```

- Each transaction gets one confirm span per tracker. If the caller also waits for the receipt on a client
  extended with the same tracker, both waits share that span: a receipt from either ends it, and a background
  timeout does not end it while the caller is still waiting. A wait without a timeout (`timeout: 0`) for a
  transaction that is never mined therefore keeps the span open.
- Polling adds RPC requests to your provider (one receipt request per polling interval until the receipt arrives).
  It polls independently of your own `waitForTransactionReceipt` calls, so your `timeout`, `confirmations` and other
  options always apply to your wait; while both run, receipt requests are made for each.
- A pending confirmation keeps the Node.js process alive until the receipt arrives or `timeoutMs` (default
  120 000 ms) passes; the span then ends as an error with `error.type` `timeout`.
- viem's `waitForTransactionReceipt` fails on the first failed request of its poll (a rate limit, a JSON-RPC error,
  a request timeout, a connection reset), and with `TransactionReceiptNotFoundError` when a node returns a mined
  transaction before its receipt. Background confirmation and `watch()` then wait one polling interval and poll
  again, until `timeoutMs`: the span ends as `timeout` only if no receipt came, and a provider that keeps failing
  holds the confirmation (and its place under `maxBackgroundConfirmations`) until then. Your own waits are passed on
  unchanged, including these errors.
- At most `maxBackgroundConfirmations` (default 256) background confirmations, including those of `watch()`, poll at
  once. A transaction sent while that many are polling gets no background confirm span, and a `diag` warning is
  logged; `0` turns background confirmation off. Your own waits are not counted. See
  [ADR 0018](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0018-background-confirmation-limit.md).
- In serverless runtimes that freeze after the response, background confirmations may not complete.

## Many transactions

In a worker or a bot that sends many transactions, these limits decide what is recorded:

- **Background confirmations at once.** Past `maxBackgroundConfirmations`, a transaction gets no background confirm
  span and so no confirmation or fee sample ([background confirmation](#background-confirmation)). Size it to the
  transactions you send per second times how long one takes to confirm, or wait for receipts yourself: your own waits
  are not counted.
- **Requests to your provider.** Each background confirmation polls for its receipt through the sending client, at
  the client's `pollingInterval`
  ([JSON-RPC requests hashspan adds](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/architecture.md#json-rpc-requests-hashspan-adds)).
- **Links to the send.** The tracker keeps a send for `linkTtlMs` after it ended, and at most
  `maxTrackedTransactions` sends ([core options](https://github.com/selimaytac/hashspan/tree/@hashspan/viem@1.0.0/packages/core#options)). A confirmation that starts later, or
  after that many newer sends, has no link, and without an active span starts a trace of its own. Background
  confirmation starts at the send and is not affected; a wait or a `watch()` you start later is, so raise both when
  you confirm in batches long after sending.
- **Sampling.** The send, confirmation and fee [metrics](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/semconv.md#metrics) record every transaction
  whatever the sampler decides, so their percentiles stay complete while you sample traces. With a parent-based
  sampler, a send and its confirm span are kept or dropped together
  ([troubleshooting](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/troubleshooting.md#a-send-span-but-no-confirm-span)).

## Smart accounts (ERC-4337)

A smart account sends user operations, not transactions: a bundler includes them in a bundle transaction that the
bundler sends. On a bundler client from viem's `createBundlerClient`, `withHashspan()` traces `sendUserOperation`
and `waitForUserOperationReceipt` as `send` and `confirm` spans identified by the user operation hash:

```ts
import { createPublicClient, http } from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

const client = createPublicClient({ chain: baseSepolia, transport: http() });
const bundler = createBundlerClient({ account, client, transport: http(bundlerUrl) }).extend(
  withHashspan(),
);

const hash = await bundler.sendUserOperation({ calls: [{ to, value }] }); // send span
await bundler.waitForUserOperationReceipt({ hash }); // confirm span, linked to the send span
```

- The send span covers preparing, signing and handing the operation to the bundler, and is the active span while
  that runs, so spans that your RPC or HTTP instrumentation creates for the bundler and paymaster requests nest under
  it. It records the smart account, EntryPoint, number of calls and user operation hash, and no `blockchain.tx.*`
  attribute.
- The confirm span records the operation's success, gas used and cost (`actualGasCost`), nonce (a decimal string)
  and paymaster, and the bundle transaction's hash and block. An operation whose calls reverted ends with
  `error.type` `reverted` and its decoded revert reason, even though the bundle transaction succeeded. The bundle
  transaction's status and fee are not recorded: they cover every operation in the bundle. The fee histogram records
  the operation's cost
  ([ADR 0021](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0021-user-operations.md)).
- The chain id is the bundler client's, which `createBundlerClient` takes from its `client`; without one, the spans
  are recorded once the bundler answered `eth_chainId`, as for [clients without a chain](#clients-without-a-chain).
- Only these two bundler actions are traced; viem calls the others from inside them. Background confirmation and
  `watch()` cover transactions only: a user operation gets a confirm span when you wait for its receipt.

## Call batches (EIP-5792)

A wallet that supports EIP-5792 takes a batch of calls with `wallet_sendCalls` and returns a batch id; the wallet
decides how the calls reach the chain. `withHashspan()` traces `sendCalls`, `waitForCallsStatus` and `sendCallsSync`
as `send` and `confirm` spans identified by the batch id:

```ts
import { createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

const wallet = createWalletClient({ account, chain: base, transport: custom(provider) }).extend(
  withHashspan(),
);

const { id } = await wallet.sendCalls({ calls: [{ to, value }] }); // send span
await wallet.waitForCallsStatus({ id }); // confirm span, linked to the send span
```

- The send span covers handing the batch to the wallet, and records the account, number of calls and batch id.
- The confirm span records the outcome (`blockchain.call_batch.status`: `success` for 200, `reverted` for 500,
  `partially_reverted` for 600), the status code, whether the batch ran atomically, the hashes of the transactions
  that carried it, and the highest block among its receipts. A status 400 ends with `error.type` `failed`, any other code with `_OTHER`; a
  wait that accepts a pending status ends without an outcome. No fee is recorded: wallet receipts lack the L1 fee and
  can be a bundle transaction shared with others. Batch ids must be `0x`-prefixed hex; others are not recorded.
- With `experimental_fallback`, viem sends the calls as plain transactions when the wallet lacks `wallet_sendCalls`.
  Each is confirmed as a transaction linked to the batch's send span, as `watch()` does, so its receipt and fee are
  recorded whether or not background confirmation is on. Each of these confirmations polls until `confirm.timeoutMs`
  (120 000 ms by default, also without background mode) and counts toward `maxBackgroundConfirmations`.
- `sendCallsSync` records one send span and one confirm span: viem's own `sendCallsSync` runs with the traced
  `sendCalls` and `waitForCallsStatus`, so an extension applied before this one that replaces `sendCallsSync` itself
  is not called ([apply it last](#apply-it-last)). This needs viem 2.45.2 or later: from 2.38.0 to 2.45.1, viem's
  `sendCallsSync` calls the two actions directly, so the batch is sent and waited for untraced, with its result
  unchanged. `getCallsStatus` is not traced: polling it yourself records
  nothing, as with `getTransactionReceipt`. Background confirmation and `watch()` do not cover batches.
- See [ADR 0022](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0022-call-batches.md).

## JSON-RPC requests

`traceTransport()` wraps a viem transport so that each request it sends becomes a client span named after its
JSON-RPC method, such as `eth_sendRawTransaction`. With `withHashspan()`, the requests of a transaction nest under its
`send` span, so a slow or failing provider call shows up there:

```ts
const wallet = createWalletClient({
  account,
  chain,
  transport: traceTransport(http(), {
    methods: (method) => method !== 'eth_getTransactionReceipt',
  }),
}).extend(withHashspan());
```

- Spans follow the OpenTelemetry RPC conventions: `rpc.system.name` `jsonrpc`, `rpc.method`,
  `jsonrpc.protocol.version`, and `server.address` and `server.port` from the transport's URL, plus
  `blockchain.chain.id`. No parameters or results are recorded, and of the URL only the host and port, since the
  path often holds an API key. The host is recorded as it is: with a provider that gives each endpoint its own
  subdomain, it identifies your endpoint. These spans do not pass through the tracker's `redact` hook; to leave the
  host out, drop `server.address` in a span processor or a collector rule.
- A failed request ends with error status and `error.type`: its JSON-RPC error code (also `rpc.response.status_code`)
  or the error's class name, never the message.
- `methods` chooses which methods get a span (default: all); the example leaves out receipt polling.
  `tracerProvider` replaces the global tracer provider.
- See [ADR 0019](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/adr/0019-json-rpc-spans.md).

## Traced actions

| Action | Span | Recorded |
|---|---|---|
| `sendTransaction` | `send` | chain id, from, to, value, nonce (when the call passes one), function selector, hash, and the EIP-7702 authorizations of a type 4 transaction (count, delegated addresses, chain ids; never signatures) |
| `writeContract` | `send` | as above, plus the function name, and the call arguments with `recordFunctionArguments: true` |
| `sendTransactionSync`, `writeContractSync` | `send` and `confirm` | as `sendTransaction` or `writeContract` and `waitForTransactionReceipt`; both spans cover the call, since viem returns the hash only with the receipt |
| `sendRawTransaction` | `send` | on a wallet or a public client, from the signed transaction: chain id (the client's when it has none), to, value, nonce, function selector, hash and EIP-7702 authorizations; no sender, which only the signature gives. A transaction that viem cannot parse, or longer than 128 KiB, records the chain id and hash only |
| `sendRawTransactionSync` | `send` and `confirm` | as `sendRawTransaction` and `waitForTransactionReceipt`, over the call like the other sync forms |
| `waitForTransactionReceipt` | `confirm` | status, block, gas used, effective gas price, L1 fee (OP-stack) and total fee from the sealed receipt ([preconfirmed receipts](#preconfirmed-receipts-flashblocks)), the OP Stack operator fee ([below](#op-stack-operator-fee)), revert reason, replacement |
| `sendUserOperation` | `send` | chain id, smart account, EntryPoint, number of calls, user operation hash; see [Smart accounts](#smart-accounts-erc-4337) |
| `waitForUserOperationReceipt` | `confirm` | success, gas used, cost, nonce, paymaster, revert reason, bundle transaction hash and block |
| `sendCalls` | `send` | chain id, account, number of calls, batch id; see [Call batches](#call-batches-eip-5792) |
| `waitForCallsStatus` | `confirm` | outcome, status code, atomicity, transaction hashes, highest block |
| `sendCallsSync` | `send` and `confirm` | as `sendCalls` and `waitForCallsStatus` |

While `sendTransaction`, `writeContract`, `sendRawTransaction` (or their sync forms), `sendUserOperation` or
`sendCalls` runs, its send span is the active span, so spans that your RPC or HTTP
instrumentation creates for the request nest under it; the code after the call stays in your own context.

Failed sends, reverted receipts and receipt timeouts set error status; the original error is always rethrown
unchanged. Spans record only the error type unless `errorMessages` allows more, because viem error messages
include the request arguments. A failed send's `error.type` is the error viem classified the failure as, under the
error it throws: for example `NonceTooLowError`, `InsufficientFundsError` or `IntrinsicGasTooLowError` under a
`TransactionExecutionError`, or the bundler's error under a `UserOperationExecutionError`; `exception.type` stays
the class it threw. For the actions that are not traced, see [known limits](#known-limits).

## Apply it last

`client.extend()` lets later extensions replace earlier actions. Extensions such as `publicActions` define
`waitForTransactionReceipt` again and hide the traced version, so apply `withHashspan()` after them:

```ts
// Traced
walletClient.extend(publicActions).extend(withHashspan());
// Not traced: publicActions replaces waitForTransactionReceipt
walletClient.extend(withHashspan()).extend(publicActions);
```

When a framework extends the client you pass in, check whether confirm spans appear; send spans are unaffected.

## Known limits

- Not traced: `deployContract` ([#36](https://github.com/selimaytac/hashspan/issues/36)).
- `sendTransactionSync` and `writeContractSync` (viem 2.38.0) send and wait in one call: their send span ends when
  the receipt arrives, and a wait that times out inside the call is recorded as a failed send without a hash and no
  confirm span.
- Only actions called as methods of an extended client are traced as such: a library that calls viem's actions as
  functions bypasses the extension for that action, and one that creates its own client bypasses it entirely. A
  function is recorded only through the client actions viem calls inside it, with less detail
  ([libraries that take a viem client](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.0.0/docs/integrations.md#libraries-that-take-a-viem-client)),
  and an extension applied after `withHashspan()` can hide the traced actions ([apply it last](#apply-it-last)).
- A transaction sent by a wallet API or a wallet provider that creates its own client gets a confirm span through
  `watch()`, and a send span only when you record the call that sends with the same tracker
  ([transactions sent elsewhere](#transactions-sent-elsewhere)).
- Only waits are traced: polling `getTransactionReceipt` or `getCallsStatus` yourself records nothing
  ([call batches](#call-batches-eip-5792)).
- Background confirmation and `watch()` cover transactions only: a user operation or a call batch gets a confirm span
  only from your own wait ([smart accounts](#smart-accounts-erc-4337), [call batches](#call-batches-eip-5792)).
- `sendCallsSync` is traced from viem 2.45.2, and call batches record no fee
  ([call batches](#call-batches-eip-5792)).
- A transaction sent while `maxBackgroundConfirmations` confirmations are polling gets no background confirm span, and
  in serverless runtimes that freeze after the response, background confirmations may not complete
  ([background confirmation](#background-confirmation)).
- A wait that resolves with the receipt of another transaction that viem did not report as a replacement, as after a
  mixed-up RPC response, ends the confirm span with `error.type` `_OTHER` and records none of that receipt's data;
  the transaction's own outcome is not recorded ([#355](https://github.com/selimaytac/hashspan/issues/355)).
- A preconfirmed receipt whose sealed receipt does not come in time is recorded without fees
  ([preconfirmed receipts](#preconfirmed-receipts-flashblocks)).
- Revert reasons are best effort: a provider without historical state cannot replay the transaction, and earlier
  transactions in the same block can change the result ([revert reasons](#revert-reasons)).
- On a client without a chain, a call is not traced when its `eth_chainId` request fails or has not answered 30 s
  after the call ended ([clients without a chain](#clients-without-a-chain)).
- The limits of the core apply too
  ([`@hashspan/core` known limits](https://github.com/selimaytac/hashspan/tree/@hashspan/viem@1.0.0/packages/core#known-limits)).

## License

Apache-2.0
