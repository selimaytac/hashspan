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

`withHashspan(options)` accepts all [`@hashspan/core` options](../core#options) (address mode, agent identity,
redaction hook) plus `tracker` to report to an existing tracker.

## Traced actions

| Action | Span | Recorded |
|---|---|---|
| `sendTransaction` | `send` | chain id, from, to, value, nonce, function selector, hash |
| `writeContract` | `send` | as above, plus the function name |
| `waitForTransactionReceipt` | `confirm` | status, block, gas used, effective gas price, L1 fee (OP-stack), total fee |

Failed sends, reverted receipts and receipt timeouts set error status; the original error is always rethrown
unchanged. Not traced yet: `deployContract`, `sendRawTransaction`, `sendCalls`.

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
