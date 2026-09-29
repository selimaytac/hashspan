# @hashspan/core

Transaction lifecycle tracing for the on-chain actions of AI agents, built on OpenTelemetry.

`@hashspan/core` turns a transaction into two spans inside your existing trace:

- **`send {chainId}`**: from "about to send" until the transaction hash is known (or sending failed).
- **`confirm {chainId}`**: waiting for the receipt: status, block, gas, fees (including the OP-stack L1 fee) and
  revert reason. It carries a span link to its `send` span.

The core is library-agnostic and read-only: it never signs, sends or fetches anything. Adapters such as
[`@hashspan/viem`](https://github.com/selimaytac/hashspan/tree/main/packages/viem) call it for you. Use the core directly to instrument any other send path.

## Install

```sh
npm install @hashspan/core @opentelemetry/api
```

`@opentelemetry/api` is the only peer dependency. Bring your own OpenTelemetry SDK and exporter. Requires Node.js 22.3
or later; in other runtimes, `hashed` address mode needs a custom `hash` function and otherwise records no addresses,
with a `diag` warning.

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

Both calls accept an explicit parent `Context` as a second argument. An integration that learns about a call only
after it started can record it after the fact: pass `startTime` in the input and the end time as the last argument
of the handle method, e.g. `send.end(hash, endTime)` ([ADR 0009](https://github.com/selimaytac/hashspan/blob/main/docs/adr/0009-telemetry-off-the-call-path.md)). Every method is safe to call: failures inside
the instrumentation are reported through `diag` and never thrown into your code.

## Options

| Option | Default | Description |
|---|---|---|
| `tracerProvider` | global provider | Tracer provider to use |
| `address` | `'raw'` | `'raw'`, `'hashed'`, `'off'`, or `{ mode: 'hashed', hash: (address) => string }` |
| `errorMessages` | `'off'` | What failed spans record about the error: `'off'` (type only), `'sanitized'` (first line, addresses per `address` mode, calldata removed; in `hashed` and `off` mode any hex longer than an address) or `'raw'` (full message and stack trace). `'raw'` can record RPC URLs that include API keys, as some libraries put the request URL in the message; `'sanitized'` keeps only the first line (viem puts the URL on a later line), which is best effort. See [ADR 0006](https://github.com/selimaytac/hashspan/blob/main/docs/adr/0006-error-privacy.md) |
| `recordFunctionArguments` | `false` | Record `functionArguments` as a JSON array in `blockchain.contract.function.arguments`: bigints as decimal strings, addresses per `address` mode (longer hex values become `<hex>` in `hashed` and `off` mode), at most 4096 characters. Reads only own enumerable data properties: `toJSON()` and getters are never called, so a `Date` records as `{}`; a Proxy's traps still run |
| `agent` | none | Agent `{ id, name }`; a field set here always wins, unset fields come from the Baggage entries `gen_ai.agent.id` / `gen_ai.agent.name` |
| `agentFromBaggage` | `true` | Read agent identity fields that `agent` leaves unset from Baggage; set to `false` in services that accept requests from outside their trust boundary |
| `redact` | none | `(attributes) => attributes`, runs last on every attribute set, including exception event attributes; if it throws, only non-sensitive identifiers are kept |
| `linkTtlMs` | `600000` | How long a sent transaction can be linked from its confirmation |
| `maxTrackedTransactions` | `10000` | Upper bound on transactions kept for linking |

## What is recorded

Chain id, transaction hash, sender/recipient (per `address` mode), value, nonce, function name and selector, and,
on confirmation, status, block number, gas used, effective gas price, L1 fee, total fee and revert reason. Decoded
call arguments are recorded only with `recordFunctionArguments`, and error messages only with `errorMessages`.
Attribute definitions:
[docs/semconv.md](https://github.com/selimaytac/hashspan/blob/main/docs/semconv.md).

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
  ([ADR 0011](https://github.com/selimaytac/hashspan/blob/main/docs/adr/0011-agent-identity-precedence.md)).
- The redaction hook (`redact`) runs last on every attribute set and on exception attributes; use it for anything
  else your policy forbids.

## License

Apache-2.0
