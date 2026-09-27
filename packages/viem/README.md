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
| `tracker` | new tracker | Report to an existing `@hashspan/core` tracker |
| `confirm` | none | `{ mode: 'background', timeoutMs? }` confirms every sent transaction without an explicit wait |
| `decodeRevertReason` | `true` | Replay reverted transactions to record their revert reason |

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
- Turn it off with `withHashspan({ decodeRevertReason: false })`.

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

- Each transaction gets exactly one confirm span. If the caller also waits for the receipt on a client extended
  with the same `withHashspan()` result, no second span is created.
- Polling adds RPC requests to your provider (one receipt request per polling interval until the receipt arrives).
- A pending confirmation keeps the Node.js process alive until the receipt arrives or `timeoutMs` (default
  120 000 ms) passes; the span then ends with status `timeout`.
- In serverless runtimes that freeze after the response, background confirmations may not complete.

## Traced actions

| Action | Span | Recorded |
|---|---|---|
| `sendTransaction` | `send` | chain id, from, to, value, nonce, function selector, hash |
| `writeContract` | `send` | as above, plus the function name |
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
