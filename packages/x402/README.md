# @hashspan/x402

Trace the payments your AI agents make over [x402](https://www.x402.org) with OpenTelemetry.

With x402, an agent pays for an API call by signing an authorization; the API's facilitator then sends the
settling transaction from its own account. This adapter records each payment as a `payment {chainId}` span inside
your agent's trace, with what was paid, to whom, for which resource and whether it settled, and, with a reader, a
linked `confirm {chainId}` span with block, gas and fees. It records no `send` span, since the agent did not send the
transaction ([ADR 0013](https://github.com/selimaytac/hashspan/blob/@hashspan/x402@0.9.0/docs/adr/0013-x402-payments.md)).

## Install

```sh
npm install @hashspan/x402 @x402/core @x402/evm @x402/fetch @opentelemetry/api viem
```

`@x402/evm` and `@x402/fetch` are the payment scheme and HTTP client of the example below; install the ones your setup
uses.

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

`withHashspan(client, options)` accepts the [`@hashspan/core` options](https://github.com/selimaytac/hashspan/tree/@hashspan/x402@0.9.0/packages/core#options)
(address mode, agent identity, redaction hook, ...), `decodeRevertReason` as in `@hashspan/viem` but off by default,
`maxBackgroundConfirmations` as in `@hashspan/viem` (it limits the confirmations through the reader; a payment whose
confirmation is not started gets no `verified`), `tracker`, `reader` (a viem public client, or a function returning
one for a chain id) and `confirmTimeoutMs` (default 120 000 ms). Without a reader, only payment spans are recorded.
Give it the same `tracker` as `@hashspan/viem` or `@hashspan/cdp` to share one tracker between adapters; with
`tracker`, the core options are not used.

The settlement and its transaction hash come from the server you pay. With a reader, the payment span records
`blockchain.payment.verified`: `true` when the reported transaction's receipt carries your payment, `false` when it
does not. For an `exact` payment authorized with EIP-3009, that means the token emitted `AuthorizationUsed` with your
nonce and `Transfer` from you to `payTo` of exactly the amount. For an `exact` payment authorized with Permit2, the
transaction was sent to the x402 proxy you authorized, which emitted its settlement event, and the token emitted
`Transfer` from you to `payTo` of exactly the amount; for `upto`, the transaction was also sent by the facilitator
your authorization names, and the transfer is of more than nothing, at most your maximum and, when the settlement
reports an amount, exactly that amount. For both, the reader also fetches the mined transaction: its input must pass your Permit2 nonce
and your address as the owner, so the transaction of an earlier payment is `false`, whichever client or process
verified it. All of it is checked from your own payment, not from the settlement. The attribute is absent when no
check was possible, for example: no reader, no receipt, a reverted one, a transaction that cannot be read, a
settlement on another network, an authorization that does not match the requirements, or another scheme (such as
`batch-settlement`). With a reader, the payment span is exported once the receipt is checked; its end time stays
when the response came. The revert reason of a reverted settlement, which would be text from a contract the server
chooses, is only recorded with `decodeRevertReason: true`. See
[ADR 0017](https://github.com/selimaytac/hashspan/blob/@hashspan/x402@0.9.0/docs/adr/0017-x402-payment-verification.md).

`flush({ timeoutMs })` (default 10 000 ms) waits for payments still waiting for their response, then for
confirmations through the reader, and ends what is left as `timeout` (a payment already settled and waiting for its
receipt check ends as settled, without `verified`). Call it before a short-lived process exits.

## Recorded

| Outcome | Payment span |
|---|---|
| Settled | `blockchain.payment.status` `settled` and the transaction hash |
| Settlement pending (`settlement_pending`) | `pending` and the hash; the confirm span resolves it |
| Settlement failed | `failed`, error status, the facilitator's `errorReason` as `error.type` |
| Response without a settlement: the facilitator refused the payment before settling it (e.g. the payer's balance is too low), or the API failed (e.g. answered 500) before settling; see [payment, request and task outcomes](#payment-request-and-task-outcomes) | error status, `error.type` `no_settlement` |
| No response: the paid request failed on the network, `@x402/axios` got a status other than 2xx or 402, or no response came before the authorization expired | error status, `error.type` `timeout`, once the requirements' `maxTimeoutSeconds` plus 30 s passed (at least 30 s, at most 1 h; 300 s when the requirements give none), when more than 1000 payments are open (the oldest first), or on `flush()` |
| Creating the payment failed (e.g. signing) | error status, the error's class name as `error.type` |

Every payment span records the payer, recipient (`payTo`), asset, the amount the payer signed for and scheme, and the
origin of the resource URL, e.g. `https://api.example.com`: paths of paid APIs often carry user or account
identifiers. The core option `paymentResource: 'path'` records the path too (never the query string, fragment or user
info), and `'off'` nothing; see
[docs/semconv.md](https://github.com/selimaytac/hashspan/blob/@hashspan/x402@0.9.0/docs/semconv.md). When the
settlement reports the amount it settled, it is recorded as `blockchain.payment.settled_amount`, as reported: with the
`upto` scheme, it can be less than the amount signed for.

Not traced: x402 v1 payments (`registerExactEvmScheme` registers v1 networks too) and networks other than `eip155`,
with a `diag` warning once per version or network; payments that client policies or spend controls refuse, which
happens before any hook runs. If another `onPaymentCreationFailure` hook recovers a failed payment, its span still
records the failure.

## Payment, request and task outcomes

The payment span records the payment, not the paid request or your tool: the x402 client hooks never see the
response's status. Whether the tool succeeded is on your tool span (or your framework's), the parent of the payment
and confirm spans. Together they tell these cases apart, checked with `@x402/core` 2.28 on Anvil:

| What happened | Payment spans under the tool span | Tool span |
|---|---|---|
| The API failed before settling (by default a server settles after its handler, and not when the handler failed) | one, `no_settlement` | error, if the tool fails on the status |
| The API settled, then failed: a server that settles before its handler (`paymentFlow` `upfront`) answered 500 | one, `settled` and `verified` | error, if the tool fails on the status; otherwise nothing records the failure |
| The request succeeded, the tool failed on the response | one, `settled` | error |
| The tool retried and paid again | two, `settled`, with two settlement transactions | as the retry ended |
| The tool retried after a request that was not settled | two: one `no_settlement`, one `settled` | as the retry ended |
| The settlement transaction does not carry the payment | `settled`, `verified` `false` | |
| The settlement's outcome is unknown | `pending`, and the linked confirm span ends with `error.type` `timeout` | |

Count only `settled` payments as paid; a `pending` one is paid once its confirm span records the receipt. What a
tool call or task spent is the `amount` of each settled payment (the `settled_amount` for `upto`), per
`blockchain.payment.asset`: amounts of different assets do not add up. The settlement's gas was paid by the
facilitator, not by the agent. Spans are not an accounting record: a trace that a sampler dropped, or that was not
exported, misses its payments.

## License

Apache-2.0
