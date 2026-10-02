# @hashspan/core

Transaction lifecycle tracing for the on-chain actions of AI agents, built on OpenTelemetry.

`@hashspan/core` turns a transaction into two spans inside your existing trace:

- **`send {chainId}`**: from "about to send" until the transaction hash is known (or sending failed).
- **`confirm {chainId}`**: waiting for the receipt: status, block, gas, fees (including the OP-stack L1 fee) and
  revert reason. It carries a span link to its `send` span.

Payments that another party settles on chain, such as x402 payments, become a **`payment {chainId}`** span instead
of a `send` span.

The core is library-agnostic and read-only: it never signs, sends or fetches anything. Adapters such as
[`@hashspan/viem`](https://github.com/selimaytac/hashspan/tree/@hashspan/core@0.8.0/packages/viem) call it for you. Use the core directly to instrument any other send path.

## Install

```sh
npm install @hashspan/core @opentelemetry/api
```

`@opentelemetry/api` is the only peer dependency. Bring your own [OpenTelemetry SDK and exporter](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/). Requires Node.js 22.3
or later; in other runtimes, `hashed` address mode needs a custom `hash` function and otherwise records no addresses,
with a `diag` warning.

## Usage

```ts
import { createTxTracker } from '@hashspan/core';
import { context } from '@opentelemetry/api';

const tracker = createTxTracker({ agent: { name: 'treasury-bot' } });

// Inside your tool, where the agent framework's span is active:
const send = tracker.startSend({ chainId: 8453, from, to, value, functionName: 'transfer' });
let hash: string;
try {
  // Run in the send span's context, so that wallet or RPC spans of the call nest under it.
  hash = await context.with(send.context, () => sendSomehow());
  send.end({ hash });
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

`send.fail(error, { errorType })` records a library's machine-readable error code as `error.type` instead
of the error's class name, if it is a short identifier (`[A-Za-z0-9_.-]`, at most 64 characters); `exception.type`
stays the class name.

`tracker.startPayment({ chainId, protocol, payer, recipient, asset, amount })` records a payment that another
party settles on chain, such as an x402 facilitator, as a `payment {chainId}` span; end it with
`end({ status, hash })`, `fail(error)` or `timeout()`, and call `link(hash)` to link a settling transaction's confirm
span before the payment ends. A settlement with a hash links the transaction's confirm span to the payment
span ([ADR 0013](https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.8.0/docs/adr/0013-x402-payments.md)).

`tracker.startUserOperationSend({ chainId, sender, entryPoint, callCount })` records a user operation of an ERC-4337
smart account handed to a bundler as a `send {chainId}` span; end it with `end({ userOpHash })` or `fail(error)`.
`tracker.startUserOperationConfirm({ chainId, userOpHash })` joins its confirm span, as `startConfirm` does for a
transaction, and `end(receipt)` takes the operation's receipt: `success`, `actualGasCost`, `actualGasUsed`, `sender`,
`nonce`, `paymaster`, `entryPoint`, `revertReason`, and the bundle transaction's `transactionHash` and `blockNumber`.
A receipt with `success: false` ends the span with `error.type` `reverted`; the bundle transaction's status and fee
are not recorded, since they cover every operation in the bundle
([ADR 0021](https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.8.0/docs/adr/0021-user-operations.md)).

All of these calls accept an explicit parent `Context` as a second argument. An integration that learns about a call only
after it started can record it after the fact: pass `startTime` in the input and `endTime` in the options of the
handle method, e.g. `send.end({ hash }, { endTime })` ([ADR 0009](https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.8.0/docs/adr/0009-telemetry-off-the-call-path.md)). Every method is safe to call: failures inside
the instrumentation are reported through `diag` and never thrown into your code. The positional forms of earlier
releases, `send.end(hash, endTime)` and `send.fail(error, endTime, { errorType })`, and those of the confirm handle,
`end(receipt, endTime)`, `timeout(endTime)` and `fail(error, endTime)`, still work and are deprecated until 1.0 ([ADR 0014](https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.8.0/docs/adr/0014-core-api-boundary.md)).

## Options

| Option | Default | Description |
|---|---|---|
| `tracerProvider` | global provider | Tracer provider to use |
| `meterProvider` | global provider | Meter provider for the [metrics](#metrics) |
| `address` | `'raw'` | `'raw'`, `'hashed'`, `'off'`, or `{ mode: 'hashed', hash: (address) => string }` |
| `errorMessages` | `'off'` | What failed spans record about the error: `'off'` (type only), `'sanitized'` (first line, at most 256 characters, addresses per `address` mode, calldata removed; in `hashed` and `off` mode any hex longer than an address) or `'raw'` (full message and stack trace). `'raw'` can record RPC URLs that include API keys, as some libraries put the request URL in the message; `'sanitized'` keeps only the first line (viem puts the URL on a later line), which is best effort. See [ADR 0006](https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.8.0/docs/adr/0006-error-privacy.md) |
| `paymentResource` | `'origin'` | How much of a paid resource's URL `x402.resource` records: `'origin'` (scheme, host and port; nothing for a resource that is not a URL), `'path'` (also the path, never the query string, fragment or user info) or `'off'`. Paths often carry user or account identifiers. At most 512 characters are recorded |
| `recordFunctionArguments` | `false` | Record `functionArguments` as a JSON array in `blockchain.contract.function.arguments`: bigints as decimal strings, addresses per `address` mode (longer hex values become `<hex>` in `hashed` and `off` mode), at most 4096 characters. Reads only own enumerable data properties: `toJSON()` and getters are never called, so a `Date` records as `{}`; a Proxy's traps still run |
| `agent` | none | Agent `{ id, name }`; a field set here always wins, unset fields come from the Baggage entries `gen_ai.agent.id` / `gen_ai.agent.name` |
| `agentFromBaggage` | `true` | Read agent identity fields that `agent` leaves unset from Baggage; set to `false` in services that accept requests from outside their trust boundary |
| `redact` | none | `(attributes) => attributes`, runs last on every span attribute set, including exception event attributes, but not on [metrics](#metrics); if it throws or returns something other than an attributes object, only non-sensitive identifiers are kept |
| `linkTtlMs` | `600000` | How long a sent transaction or user operation can be linked from its confirmation, and how long after a receipt further waits for it add no confirm span |
| `maxTrackedTransactions` | `10000` | Upper bound on transactions, and separately on user operations, kept for linking and confirm deduplication |

## What is recorded

Chain id, transaction hash, sender/recipient (per `address` mode), value, nonce, function name and selector, and,
on confirmation, status, block number, gas used, effective gas price, L1 fee, total fee and revert reason. For user operations: their hash,
smart account, EntryPoint, number of calls, success, gas used, cost, nonce and paymaster. For payments: payer,
recipient, asset, amount, settled amount, status and whether the settlement was verified, and for x402 the scheme and
resource. For a replaced transaction: the replacing hash and the reason. On every span: the agent identity. Decoded
call arguments are recorded only with `recordFunctionArguments`, and error messages only with `errorMessages`.
Attribute definitions:
[docs/semconv.md](https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.8.0/docs/semconv.md).

## Metrics

With an OpenTelemetry metrics SDK set up (or `meterProvider`), the tracker records three histograms:
`blockchain.client.send.duration` and `blockchain.client.confirmation.duration` in seconds, and
`blockchain.client.fee` in wei. Their attributes are the system, the chain and the outcome (and, on samples of user
operations, `blockchain.operation.subject`), never an address, hash or agent identity; an `error.type` that is
neither an error class name ending in `Error` nor a lower-case code of letters and underscores is recorded as
`_OTHER`.
The `redact` hook does not run on metrics: a fee it removes from spans is still recorded by
`blockchain.client.fee`. To keep a histogram out of your backend, drop it with a View of your metrics SDK (drop
aggregation). Definitions:
[docs/semconv.md](https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.8.0/docs/semconv.md#metrics).

## Privacy notes

- **Address modes are not anonymity.** `address: 'off'` and `'hashed'` keep addresses out of your telemetry
  backend. They do not hide who transacted: every span carries the transaction hash, and anyone can look up its
  sender, recipient, value and calldata in a block explorer. Use them to limit what your backend stores and who can
  query it, not to make transactions untraceable.
- **Agent identity in Baggage travels.** Baggage is propagated to every downstream service your instrumented clients
  call when a Baggage propagator is configured (it is part of the default OpenTelemetry SDK setup), including third
  party APIs. Put only identifiers there that may leave your system, such as an opaque agent id. For identifiers
  that must stay internal, use the tracker's static `agent` option instead, which is recorded on spans but never
  propagated, or strip the entries before outbound calls.
- **Inbound Baggage can claim an identity.** A caller can send Baggage entries with any agent id. A field set in the
  `agent` option cannot be overridden that way; to ignore identity from Baggage entirely, set `agentFromBaggage: false`
  ([ADR 0011](https://github.com/selimaytac/hashspan/blob/@hashspan/core@0.8.0/docs/adr/0011-agent-identity-precedence.md)).
- The redaction hook (`redact`) runs last on every span attribute set and on exception attributes; use it for
  anything else your policy forbids. It does not run on [metrics](#metrics), which carry no address or hash.
- **Your callbacks' errors go to the diagnostic logger.** If a custom `hash` function or the `redact` hook throws,
  its error object is logged through the OpenTelemetry `diag` logger, outside the address mode and the redaction
  hook. Errors of the instrumented call never are. Do not put sensitive values, such as the address being hashed,
  into errors your callbacks throw, or route `diag` to a sink your policy allows.

## License

Apache-2.0
