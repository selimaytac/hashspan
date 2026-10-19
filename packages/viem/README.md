# @hashspan/viem

OpenTelemetry instrumentation for viem. Trace the transactions your AI agents, or any of your services, send with
[viem](https://viem.sh), using OpenTelemetry.

A viem client extension that reports to [`@hashspan/core`](https://github.com/selimaytac/hashspan/tree/@hashspan/viem@1.3.0/packages/core): each transaction becomes a
`send {chainId}` span inside the active trace, such as your agent's tool call, a request or a job, and each receipt
wait a linked `confirm {chainId}` span with status, gas and fees. See also the
[viem OpenTelemetry guide](https://hashspan.dev/docs/viem-opentelemetry).

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
confirmations are linked to their sends even when they happen on a different client. Its place among other
extensions matters ([apply it last](#apply-it-last)), and a short-lived process flushes it before it exits
([shutting down](#shutting-down)).

## Traced actions

| Action | Span | Recorded |
|---|---|---|
| `sendTransaction` | `send` | chain id, from, to, value, nonce (when the call passes one), function selector, hash, and the EIP-7702 authorizations of a type 4 transaction (count, delegated addresses, chain ids; never signatures) |
| `writeContract` | `send` | as above, plus the function name, and the call arguments with `recordFunctionArguments: true` |
| `sendTransactionSync`, `writeContractSync` | `send` and `confirm` | as `sendTransaction` or `writeContract` and `waitForTransactionReceipt`; both spans cover the call, since viem returns the hash only with the receipt; a pending receipt is no outcome ([Tempo transactions](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#tempo-transactions)); no `blockchain.tx.wait.confirmations`, as the call takes no count |
| `sendRawTransaction` | `send` | on a wallet or a public client, from the signed transaction: chain id (the client's when it has none), to, value, nonce, function selector, hash and EIP-7702 authorizations; no sender, which only the signature gives. A transaction that viem cannot parse, or longer than 128 KiB, records the chain id and hash only |
| `sendRawTransactionSync` | `send` and `confirm` | as `sendRawTransaction` and `waitForTransactionReceipt`, over the call like the other sync forms |
| `waitForTransactionReceipt` | `confirm` | status, block, gas used, effective gas price, L1 fee (OP-stack) and total fee from the sealed receipt ([preconfirmed receipts](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#preconfirmed-receipts-flashblocks)), the OP Stack operator fee ([operator fee](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#op-stack-operator-fee)), the token a fee was paid in ([fees paid in a token](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#fees-paid-in-a-token)), revert reason ([revert reasons](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#revert-reasons)), replacement ([replaced transactions](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#replaced-transactions)), and the confirmations the wait asked for (`blockchain.tx.wait.confirmations`): your `confirmations` when it is a positive safe integer, `1` when it is omitted, `0`, negative or `NaN`, as viem then waits for one, and nothing for any other value |
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

## Options

`withHashspan(options)` accepts all [`@hashspan/core` options](https://github.com/selimaytac/hashspan/tree/@hashspan/viem@1.3.0/packages/core#options) (address mode, error messages,
agent identity, redaction hook) plus:

| Option | Default | Description |
|---|---|---|
| `tracker` | new tracker | A tracker from `createTxTracker()`, to share one between adapters; the core options then configure nothing, since they are the tracker's. A tracker from an older `@hashspan/core` records only what that core supports: user operations and call batches are then passed on untraced |
| `confirm` | none | `{ mode: 'background', timeoutMs? }` confirms every sent transaction without an explicit wait |
| `decodeRevertReason` | `true` | Replay reverted transactions to record their revert reason; `{ timeoutMs }` bounds the replay (default 10 000 ms); see [revert reasons](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#revert-reasons) |
| `maxBackgroundConfirmations` | `256` | Most background confirmations (background mode, `watch()` and `watchUserOperation()`) polling at once; see [Background confirmation](#background-confirmation) |
| `followMultisigOperations` | off | `true` or `{ timeoutMs? }` (default 120 000 ms): after a pending receipt of a Tempo multisig operation, wait for the transaction submitted for it; see [Tempo transactions](#tempo-transactions) |

Options are read once, from the object's own enumerable properties: options it inherits through a prototype, such as
the getters of a class instance, are ignored
([ADR 0025](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/adr/0025-untrusted-input.md)).

## Shutting down

Some spans end after the traced call returned: background confirmations, confirmations of reverted transactions,
which wait for the revert reason, confirmations of [preconfirmed receipts](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#preconfirmed-receipts-flashblocks),
which wait for the sealed receipt, and waits with `confirmations` above 1, whose receipt is read again once the wait
resolved. In scripts, CLI agents and serverless functions, flush them before
shutting the OpenTelemetry SDK down, or they are lost:

```ts
await hashspan.flush(); // at most 10 s by default: hashspan.flush({ timeoutMs })
await provider.shutdown();
```

`flush()` waits only for the work of its own `withHashspan()` result, even when results share one `tracker`: an app
with several results, or with other hashspan adapters, flushes each of them. What a timeout ends, and how:
[shutting down](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#shutting-down).

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

The requests it adds, the process it keeps alive, how it shares a span with your own waits and its limit:
[background confirmation](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#background-confirmation).

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

The options of `watch()` (`chainId`, `timeoutMs`, `abi`, `onReceipt`) and the parent of its confirm span:
[transactions sent elsewhere](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#transactions-sent-elsewhere).

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

Extensions that add their own actions are the other way round. The actions of Tempo's `tempoActions()` (`viem/tempo`),
such as `token.transfer`, call viem's actions with the client they extend: they are traced only when `withHashspan()`
was applied before `tempoActions()`, and then through the action they reach (`token.transfer` as a `sendTransaction`
to the token). Applied after it, they are not traced; their results and requests are the same either way. The same
holds for the `sendTransaction` and `writeContract` of a smart account SDK: apply `withHashspan()` before its
actions to trace their user operations ([smart account SDKs](#smart-account-sdks)).

## Many transactions

In a worker or a bot that sends many transactions, these limits decide what is recorded:

- **Background confirmations at once.** Past `maxBackgroundConfirmations`, a transaction gets no background confirm
  span and so no confirmation or fee sample ([background confirmation](#background-confirmation)). Size it to the
  transactions you send per second times how long one takes to confirm, or wait for receipts yourself: your own waits
  are not counted.
- **Requests to your provider.** Each background confirmation polls for its receipt through the sending client, at
  the client's `pollingInterval`
  ([JSON-RPC requests hashspan adds](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/architecture.md#json-rpc-requests-hashspan-adds)).
- **Links to the send.** The tracker keeps a send for `linkTtlMs` after it ended, and at most
  `maxTrackedTransactions` sends ([core options](https://github.com/selimaytac/hashspan/tree/@hashspan/viem@1.3.0/packages/core#options)). A confirmation that starts later, or
  after that many newer sends, has no link, and without an active span starts a trace of its own. Background
  confirmation starts at the send and is not affected; a wait or a `watch()` you start later is, so raise both when
  you confirm in batches long after sending.
- **Sampling.** The send, confirmation and fee [metrics](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/semconv.md#metrics) record every transaction
  whatever the sampler decides, so their percentiles stay complete while you sample traces. With a parent-based
  sampler, a send and its confirm span are kept or dropped together
  ([troubleshooting](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/troubleshooting.md#a-send-span-but-no-confirm-span)).

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

What each span covers and records, and which bundler actions are traced:
[smart accounts](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#smart-accounts-erc-4337).

### Smart account SDKs

The smart account clients of permissionless.js and ZeroDev send a user operation from `sendTransaction` and
`writeContract` (and, in permissionless, `sendCalls`), and return the bundle transaction's hash. On the finished
client, those calls are not traced, with a `diag` warning; for user operation spans from them, apply `withHashspan()`
before the SDK's actions.
Details: [smart account SDKs](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#smart-account-sdks).

### User operations sent elsewhere

When a smart account SDK or a wallet sends a user operation for you and returns only a hash, `watchUserOperation()`
records the operation's confirm span from it, in the background: its success, gas used and cost, nonce and
paymaster, and the bundle transaction's hash and block, as for a wait, linked to a send span recorded by the same
tracker. `watch()` on the same hash would record the bundle transaction instead.

```ts
import { createPublicClient, http } from 'viem';
import { withHashspan } from '@hashspan/viem';

const hashspan = withHashspan();
const reader = createPublicClient({ chain, transport: http(rpcUrl) });

// The bundle transaction's hash a wallet or an SDK returned, and the smart account that sent the operation:
hashspan.watchUserOperation(reader, { bundleHash: hash, sender: smartAccountAddress });

// Or the user operation hash, through a bundler client (createBundlerClient):
hashspan.watchUserOperation(bundler, { userOpHash });

// Before a short-lived process exits:
await hashspan.flush();
```

How the operation is found in the bundle, which client each form needs, and its options:
[user operations sent elsewhere](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#user-operations-sent-elsewhere).

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

What each span records, the `experimental_fallback` transactions and the viem releases `sendCallsSync` needs:
[call batches](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#call-batches-eip-5792).

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

The spans record the method and the host and port of the URL, never parameters, results or the URL's path. Their
attributes and options: [JSON-RPC requests](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#json-rpc-requests).

### Trace context for the provider

The JSON-RPC spans send nothing to the provider. To let an RPC gateway that reads W3C trace context, such as eRPC,
record its spans in your trace, pass `propagateTraceContext()` as the `onFetchRequest` hook of viem's `http()`
transport. Each request then carries the `traceparent` header of its JSON-RPC span:

```ts
const wallet = createWalletClient({
  account,
  chain,
  transport: traceTransport(
    http('https://rpc.example.com', { onFetchRequest: propagateTraceContext() }),
  ),
}).extend(withHashspan());
```

What it sends, and why not together with an HTTP instrumentation of `fetch`:
[trace context for the provider](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#trace-context-for-the-provider).

## Tempo transactions

A sponsored fee on Tempo is not counted as the sender's, and a sync send that a multisig relay answers with a
pending receipt gets a confirm span without an outcome, unless `followMultisigOperations` waits for the transaction
submitted for it. Details:
[Tempo transactions](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#tempo-transactions).

## More in the reference

The [`@hashspan/viem` reference](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md) has the details of these features.

### Revert reasons

A reverted transaction is replayed with `eth_call` to record its decoded revert reason. Details: [revert reasons](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#revert-reasons).

### Clients without a chain

For a client without a `chain`, the adapter asks the node for its chain id alongside each traced call. Details: [clients without a chain](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#clients-without-a-chain).

### Replaced transactions

A sped-up or cancelled transaction is recorded with the receipt of the transaction that replaced it. Details: [replaced transactions](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#replaced-transactions).

### Preconfirmed receipts (flashblocks)

A receipt answered before its block is sealed is completed from the sealed receipt. Details: [preconfirmed receipts (flashblocks)](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#preconfirmed-receipts-flashblocks).

### OP Stack operator fee

On OP Stack chains that charge an operator fee, it is recorded apart from the execution and L1 fees. Details: [OP Stack operator fee](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#op-stack-operator-fee).

### Fees paid in a token

On Celo and Tempo, the token a fee was paid in is recorded with the fee. Details: [fees paid in a token](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#fees-paid-in-a-token).

## Known limits

- Not traced: `deployContract` ([#36](https://github.com/selimaytac/hashspan/issues/36)).
- `sendTransactionSync` and `writeContractSync` (viem 2.38.0) send and wait in one call: their send span ends when
  the receipt arrives, and a wait that times out inside the call is recorded as a failed send without a hash and no
  confirm span.
- Only actions called as methods of an extended client are traced as such: a library that calls viem's actions as
  functions bypasses the extension for that action, and one that creates its own client bypasses it entirely. A
  function is recorded only through the client actions viem calls inside it, with less detail
  ([libraries that take a viem client](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/integrations.md#libraries-that-take-a-viem-client)),
  and an extension applied after `withHashspan()` can hide the traced actions ([apply it last](#apply-it-last)).
- A transaction sent by a wallet API or a wallet provider that creates its own client gets a confirm span through
  `watch()`, and a send span only when you record the call that sends with the same tracker
  ([transactions sent elsewhere](#transactions-sent-elsewhere)).
- Only waits are traced: polling `getTransactionReceipt` or `getCallsStatus` yourself records nothing
  ([call batches](#call-batches-eip-5792)).
- Background confirmation and `watch()` cover transactions only: a user operation or a call batch gets a confirm span
  only from your own wait ([smart accounts](#smart-accounts-erc-4337), [call batches](#call-batches-eip-5792)), or
  for a user operation from `watchUserOperation()`. `watch()` on a bundle transaction's hash records the bundle
  transaction, not the operations in it; `watchUserOperation()` records one operation of it, and nothing when the
  sender has several there without a nonce given
  ([user operations sent elsewhere](#user-operations-sent-elsewhere)).
- A smart account SDK's `sendTransaction`, `writeContract` and `sendCalls` are not traced on a client extended after
  the SDK's actions ([smart account SDKs](#smart-account-sdks)).
- `sendCallsSync` is traced from viem 2.45.2, and call batches record no fee
  ([call batches](#call-batches-eip-5792)).
- A transaction sent while `maxBackgroundConfirmations` confirmations are polling gets no background confirm span, and
  in serverless runtimes that freeze after the response, background confirmations may not complete
  ([background confirmation](#background-confirmation)).
- Revert reasons are best effort: a provider without historical state cannot replay the transaction, and earlier
  transactions in the same block can change the result
  ([revert reasons](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#revert-reasons)).
- Replaced transactions, Tempo, preconfirmed receipts, Celo fee currencies, clients without a chain and older viem
  releases have limits of their own
  ([reference](https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.3.0/docs/viem.md#known-limits)).
- The limits of the core apply too
  ([`@hashspan/core` known limits](https://github.com/selimaytac/hashspan/tree/@hashspan/viem@1.3.0/packages/core#known-limits)).

## License

Apache-2.0
