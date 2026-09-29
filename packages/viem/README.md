# @hashspan/viem

Trace the transactions your AI agents send with [viem](https://viem.sh), using OpenTelemetry.

A viem client extension that reports to [`@hashspan/core`](../core): each transaction becomes a
`send {chainId}` span inside your agent's trace, and each receipt wait a linked `confirm {chainId}` span with status,
gas and fees.

## Install

```sh
npm install @hashspan/viem @opentelemetry/api viem
```

Bring your own OpenTelemetry SDK and exporter.

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

`withHashspan(options)` accepts all [`@hashspan/core` options](../core#options) (address mode, error messages,
agent identity, redaction hook) plus:

| Option | Default | Description |
|---|---|---|
| `tracker` | new tracker | Report to an existing `@hashspan/core` tracker; errors thrown by it or its handles are logged through `diag`, never thrown into your call |
| `confirm` | none | `{ mode: 'background', timeoutMs? }` confirms every sent transaction without an explicit wait |
| `decodeRevertReason` | `true` | Replay reverted transactions to record their revert reason; `{ timeoutMs }` bounds the replay (default 10 000 ms) |

## Shutting down

Some spans end after the traced call returned: background confirmations, and confirmations of reverted
transactions, which wait for the revert reason. In scripts, CLI agents and serverless functions, flush them before
shutting the OpenTelemetry SDK down, or they are lost:

```ts
await hashspan.flush(); // at most 10 s by default: hashspan.flush({ timeoutMs })
await provider.shutdown();
```

`flush()` resolves `true` when all pending work finished and `false` on timeout; it never rejects. Long-running
services do not need it.

## Revert reasons

A receipt only says that a transaction reverted. For reverted transactions the adapter replays the transaction with
`eth_call` on the previous block's state and records the decoded reason as `blockchain.tx.revert.reason`:
`Error(string)` messages, `Panic` codes, and custom errors when the ABI is known (transactions sent with
`writeContract`), otherwise the error selector.

- Two extra RPC requests per reverted transaction; none for successful ones.
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
  120 000 ms) passes; the span then ends with status `timeout`.
- In serverless runtimes that freeze after the response, background confirmations may not complete.

## Traced actions

| Action | Span | Recorded |
|---|---|---|
| `sendTransaction` | `send` | chain id, from, to, value, nonce, function selector, hash |
| `writeContract` | `send` | as above, plus the function name, and the call arguments with `recordFunctionArguments: true` |
| `waitForTransactionReceipt` | `confirm` | status, block, gas used, effective gas price, L1 fee (OP-stack), total fee |

Failed sends, reverted receipts and receipt timeouts set error status; the original error is always rethrown
unchanged. Spans record only the error type unless `errorMessages` allows more, because viem error messages
include the request arguments. Not traced yet: `deployContract`, `sendRawTransaction`, `sendCalls`.

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

## License

Apache-2.0
