# @hashspan/core

Transaction lifecycle tracing for the on-chain actions of AI agents, built on OpenTelemetry.

`@hashspan/core` turns a transaction into two spans inside your existing trace:

- **`send {chainId}`**: from "about to send" until the transaction hash is known (or sending failed).
- **`confirm {chainId}`**: waiting for the receipt: status, block, gas, fees (including the OP-stack L1 fee) and
  revert reason. It carries a span link to its `send` span.

The core is library-agnostic and read-only: it never signs, sends or fetches anything. Adapters such as
[`@hashspan/viem`](../viem) call it for you. Use the core directly to instrument any other send path.

## Install

```sh
npm install @hashspan/core @opentelemetry/api
```

`@opentelemetry/api` is the only peer dependency. Bring your own OpenTelemetry SDK and exporter.

## Usage

```ts
import { createTxTracker } from '@hashspan/core';

const tracker = createTxTracker({ agent: { name: 'treasury-bot' } });

// Inside your tool, where the agent framework's span is active:
const send = tracker.startSend({ chainId: 8453, from, to, value, functionName: 'transfer' });
let hash;
try {
  hash = await sendSomehow();
  send.end(hash);
} catch (error) {
  send.fail(error);
  throw error;
}

// Later, wherever you wait for the receipt (or in a background watcher):
const confirm = tracker.startConfirm({ chainId: 8453, hash });
const receipt = await waitSomehow(hash);
confirm.end({
  status: receipt.status, // 'success' | 'reverted'
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed,
  effectiveGasPrice: receipt.effectiveGasPrice,
  l1Fee: receipt.l1Fee, // OP-stack chains
  // Hash of the mined transaction: if a replacement was mined, the receipt is attributed to it (ADR 0008).
  transactionHash: receipt.transactionHash,
});
```

`startConfirm` can be called by every part of your code that waits for the receipt: calls for the same transaction
share one confirm span. A receipt from any of them ends it; a timeout or failure ends it once every caller gave up.
End every handle you start, since an open handle keeps the shared span open.

Both calls accept an explicit parent `Context` as a second argument. Every method is safe to call: failures inside
the instrumentation are reported through `diag` and never thrown into your code.

## Options

| Option | Default | Description |
|---|---|---|
| `tracerProvider` | global provider | Tracer provider to use |
| `address` | `'raw'` | `'raw'`, `'hashed'`, `'off'`, or `{ mode: 'hashed', hash: (address) => string }` |
| `errorMessages` | `'off'` | What failed spans record about the error: `'off'` (type only), `'sanitized'` (first line, addresses per `address` mode, calldata removed) or `'raw'` (full message and stack trace) |
| `agent` | none | Fallback `{ id, name }`; Baggage entries `gen_ai.agent.id` / `gen_ai.agent.name` take precedence |
| `redact` | none | `(attributes) => attributes`, runs last on every attribute set, including exception event attributes; if it throws, only non-sensitive identifiers are kept |
| `linkTtlMs` | `600000` | How long a sent transaction can be linked from its confirmation |
| `maxTrackedTransactions` | `10000` | Upper bound on transactions kept for linking |

## What is recorded

Chain id, transaction hash, sender/recipient (per `address` mode), value, nonce, function name and selector, and,
on confirmation, status, block number, gas used, effective gas price, L1 fee, total fee and revert reason. Decoded
calldata arguments are never recorded by the core, and error messages only with `errorMessages`. Attribute definitions:
[docs/semconv.md](https://github.com/selimaytac/hashspan/blob/main/docs/semconv.md).

## License

Apache-2.0
