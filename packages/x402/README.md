# @hashspan/x402

Trace the payments your AI agents make over [x402](https://www.x402.org) with OpenTelemetry.

With x402, an agent pays for an API call by signing an authorization; the API's facilitator then sends the
settling transaction from its own account. This adapter records each payment as a `payment {chainId}` span inside
your agent's trace, with what was paid, to whom, for which resource and whether it settled, and, with a reader, a
linked `confirm {chainId}` span with block, gas and fees. It records no `send` span, since the agent did not send the
transaction ([ADR 0013](https://github.com/selimaytac/hashspan/blob/main/docs/adr/0013-x402-payments.md)).

## Install

```sh
npm install @hashspan/x402 @x402/core @opentelemetry/api viem
```

Requires Node.js 22.3 or later and `@x402/core` 2.13 or later. Bring your own [OpenTelemetry SDK and exporter](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/).

## Usage

```ts
import { withHashspan } from '@hashspan/x402';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(privateKey) });
// Registers hooks on the client; call it once per client.
const hashspan = withHashspan(client, {
  reader: createPublicClient({ chain: baseSepolia, transport: http() }),
});

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
await fetchWithPayment('https://api.example.com/weather'); // payment span, then confirm span

// Before a short-lived process exits:
await hashspan.flush();
```

Pass the `x402Client` itself: `@x402/fetch`, `@x402/axios` and `@x402/mcp` all pay through it, so one call covers
them. Helpers that build their own client from a config, such as `wrapFetchWithPaymentFromConfig`, hide it: create
it with `x402Client.fromConfig(config)` and pass it to both instead. An `x402MCPClient` exposes its client as
`paymentClient`. The adapter only registers hooks; it replaces no method, and its hooks never throw and never change
a payment.

Call `withHashspan` right after creating the client, before registering hooks of your own: the client runs hooks in
the order they were registered, and stops at the first that recovers a failed payment or a response, so a hook
registered earlier can keep hashspan from seeing the outcome, which then ends as `timeout`.

`withHashspan(client, options)` accepts the [`@hashspan/core` options](https://github.com/selimaytac/hashspan/tree/main/packages/core#options)
(address mode, agent identity, redaction hook, ...), `decodeRevertReason` as in `@hashspan/viem`, `tracker`, `reader`
(a viem public client, or a function returning one for a chain id) and `confirmTimeoutMs` (default 120 000 ms).
Without a reader, only payment spans are recorded. Give it the same `tracker` as `@hashspan/viem` or `@hashspan/cdp`
to share one tracker between adapters.

`flush({ timeoutMs })` (default 10 000 ms) waits for payments still waiting for their response, then for
confirmations through the reader, and ends what is left as `timeout`. Call it before a short-lived process exits.

## Recorded

| Outcome | Payment span |
|---|---|
| Settled | `blockchain.payment.status` `settled` and the transaction hash |
| Settlement pending (`settlement_pending`) | `pending` and the hash; the confirm span resolves it |
| Settlement failed | `failed`, error status, the facilitator's `errorReason` as `error.type` |
| Response without a settlement: the facilitator refused the payment before settling it (e.g. the payer's balance is too low), or the API failed (e.g. answered 500) | error status, `error.type` `no_settlement` |
| No response: the paid request failed on the network, `@x402/axios` got a status other than 2xx or 402, or no response came before the authorization expired | error status, `error.type` `timeout`, once the requirements' `maxTimeoutSeconds` plus 30 s passed, or on `flush()` |
| Creating the payment failed (e.g. signing) | error status, the error's class name as `error.type` |

Every payment span records the payer, recipient (`payTo`), asset, amount, scheme and the resource URL without its
query string, fragment or user info; see [docs/semconv.md](https://github.com/selimaytac/hashspan/blob/main/docs/semconv.md).

Not traced: x402 v1 payments (`registerExactEvmScheme` registers v1 networks too) and networks other than `eip155`,
with a `diag` warning once per version or network; payments that client policies or spend controls refuse, which
happens before any hook runs. If another `onPaymentCreationFailure` hook recovers a failed payment, its span still
records the failure.

## License

Apache-2.0
