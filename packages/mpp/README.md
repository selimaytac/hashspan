# @hashspan/mpp

Trace the payments your AI agents make with the [Machine Payments Protocol](https://mpp.dev) (MPP) and its
TypeScript SDK, [mppx](https://github.com/wevm/mppx), with OpenTelemetry.

With MPP, an API answers `402 Payment Required` with a challenge, and the agent pays it on Tempo with a TIP-20 token
transfer that it either sends itself (`push`) or signs for the server to broadcast (`pull`). Each payment becomes a
`payment {chainId}` span inside your agent's trace, with what was paid, to whom, in which mode and whether it settled,
and, with a reader, a linked `confirm {chainId}` span with block, gas and fees, and whether the transaction carries
this payment.

## Install

```sh
npm install @hashspan/mpp @hashspan/core @hashspan/viem mppx @opentelemetry/api viem
```

`@hashspan/core` and `@hashspan/viem` are needed for the shared tracker of the example below. Requires Node.js 22.3 or
later, mppx 0.13.5 or a later 0.13 release, and viem 2.57.1 or later (mppx's own floor). Bring your own
[OpenTelemetry SDK and exporter](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/).

## Usage

```ts
import { createTxTracker } from '@hashspan/core';
import { withHashspan } from '@hashspan/mpp';
import { withHashspan as withViemHashspan } from '@hashspan/viem';
import { Mppx, tempo } from 'mppx/client';
import { createClient, createPublicClient, http, publicActions, walletActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoChain } from 'viem/chains';

// One tracker for both adapters, so that a payment span links to the payer's own send span and each
// transaction gets one confirm span.
const tracker = createTxTracker();
const account = privateKeyToAccount(privateKey);
const wallet = createClient({ account, chain: tempoChain, transport: http() })
  .extend(publicActions)
  .extend(walletActions)
  .extend(withViemHashspan({ tracker }));

const mppx = Mppx.create({
  methods: [tempo({ account, getClient: () => wallet })],
  polyfill: false,
});
// Registers observers on the client; call it once per client.
const hashspan = withHashspan(mppx, {
  tracker,
  reader: createPublicClient({ chain: tempoChain, transport: http() }),
});

await mppx.fetch('https://api.example.com/weather'); // payment span, then confirm span

// Before a short-lived process exits:
await hashspan.flush();
```

A test runs this example as written, against an mppx server and Anvil in Tempo mode, with only its URLs redirected
([`quick-start.int.test.ts`](https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.1/packages/mpp/test/quick-start.int.test.ts)).

Pass the client `Mppx.create()` returns. Every payment made through its `fetch`, or through the global `fetch` it
polyfills (the default), reaches the adapter. The adapter only registers observers with `on()`: it replaces no
method, and its observers never throw, never return a value and never change a payment.

### Push and pull

With a private key, mppx pays in `pull` mode: it signs the transaction, and the server broadcasts it, so there is no
send span, and the confirm span comes from the reader. With `mode: 'push'`, or a wallet (JSON-RPC) account, the payer
sends the transaction itself, through the client `getClient` returns: extend that client with `@hashspan/viem`'s
`withHashspan()`, as in the example, to record the send span. Give both adapters the same `tracker`: the payment span
then starts with a link to that send span, and the transaction gets one confirm span. With two trackers, a push payment
gets two confirm spans and two fee samples for one transaction, and no link between the payment and its send.

### Options

`withHashspan(mppx, options)` accepts the [`@hashspan/core` options](https://github.com/selimaytac/hashspan/tree/@hashspan/mpp@0.1.1/packages/core#options)
(address mode, agent identity, redaction hook, ...), `decodeRevertReason` as in `@hashspan/viem` but off by default,
`maxBackgroundConfirmations` as in `@hashspan/viem` (it limits the confirmations through the reader; a payment whose
confirmation is not started gets no `verified`), `tracker`, `reader` (a viem public client, or a function returning
one for a chain id), `confirmTimeoutMs` (default 120 000 ms) and `observeFailures` (default `false`, see
[failures](#failures)). Without a reader, only payment spans are recorded,
with the settlement as the server reported it. With `tracker`, the core options are not used; it must come from
`@hashspan/core` 1.2 or later, which records who sent the settlement, and with an older one nothing is traced, with
a `diag` warning. Options are read once, from the object's own enumerable properties: options it inherits through a
prototype, such as the getters of a class instance, are ignored
([ADR 0025](https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.1/docs/adr/0025-untrusted-input.md)).

### Verified settlements

The server's `Payment-Receipt` names the settlement's transaction (`reference`). For `push`, and for `pull` without a
fee payer, the payer knows the transaction's hash before it is sent: the payment span records that hash from its
start, and a server that reports another one does not replace it. With a reader, the payment span records
`blockchain.payment.verified`: `true` when the transaction's receipt carries, from the payer's address, the transfer
of the amount to the recipient with the memo that binds it to this challenge (mppx's attribution memo: its tag, the
server's realm and the challenge id), and one transfer per split; `false` when it does not, or when the server
reported a transaction other than the payer's own. All of it is checked from the challenge the payer signed for and
the payer's own credential, not from the server's receipt. For a sponsored pull, whose hash only the server's
`reference` names, `true` also needs the mined transaction to be the one the payer signed: the reader fetches it once
(`eth_getTransactionByHash`, at most 10 s, off your call's path), and its sender must be the payer and its `nonceKey`,
`nonce`, `validBefore` and `validAfter` those of the payer's signed transaction. The attribute is absent when no
check was possible, for example: no reader, no receipt, a reverted one, a reader on another chain, a receipt funded in
another currency (`fundingCurrency`), values that do not validate, or, for a sponsored pull, a credential whose
transaction does not decode, a transaction that cannot be read or one whose sender or nonce fields differ. With a
reader, the payment span is exported once the receipt is checked; its end time stays when the response came.

### Shutting down

`flush({ timeoutMs })` (default 10 000 ms) waits for paid payments still waiting for an outcome, then for
confirmations through the reader, and ends what is left as `timeout` (a payment already settled and waiting for its
receipt check ends as settled, without `verified`). It does not wait for a challenge that was never paid (the client's
policy refused it, or signing failed): that challenge records nothing and is dropped at its deadline. Call it before
a short-lived process exits.

## Recorded

| What the client sees | Payment span |
|---|---|
| A response with a readable `Payment-Receipt` | `blockchain.payment.status` `settled` and the transaction hash: the payer's own, or for a sponsored pull the receipt's `reference` |
| A response without a `Payment-Receipt`, or with one that cannot be read | error status, `error.type` `no_settlement` or `_OTHER` |
| A 5xx answer, or a paid request that failed on the network | by default, as for no outcome below; with a reader, the confirm span of the payer's hash records the transaction. With `observeFailures`: `pending` and the hash, the confirm span resolves it, or for a sponsored pull, whose hash only the receipt names, error status with `error.type` `PaymentOutcomeUnknownError` |
| Creating the payment failed: the client's policy or spending limits, signing, or a push transaction that failed | by default, nothing. With `observeFailures`: error status, the error's class name as `error.type`, no hash |
| A challenge the client refused before paying (no method for it, an expired one) | nothing |
| A zero-amount challenge, answered with a signed proof | nothing, failures included: no value moves |
| No outcome: a 3xx, a 4xx, or a final 402 after payment | error status, `error.type` `timeout`, once the challenge's `expires` (or, without one, mppx's default validity of 25 s) plus 30 s passed (at most 1 h), when more than 1000 payments are open (the oldest first), or on `flush()`; the payer's own hash stays recorded |

Every payment span records the payer and the chain (from the credential the payer's client wrote), the recipient,
the asset (the challenge's `currency`), the amount, `mpp.method` (`tempo`), `mpp.intent` (`charge`), `mpp.mode`
(`push` or `pull`), `mpp.challenge.id` (the id the server chose, which joins your trace to the server's logs and to
the transfer's memo; on spans only) and the origin of the resource URL as `mpp.resource`, e.g.
`https://api.example.com`: paths of paid APIs often carry user or account identifiers. The core option
`paymentResource: 'path'` records the path too (never the query string, fragment or user info), and `'off'` nothing;
see [docs/semconv.md](https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.1/docs/semconv.md).

The settlement's fee is the payer's: its fee sample carries no `blockchain.fee.payer`, or `sponsor` when the server
paid it as fee payer, never `facilitator`. Count only `settled` payments as paid; a `pending` one is paid once its
confirm span records the receipt. What a tool call or task spent is the `amount` of each settled payment, per
`blockchain.payment.asset`: amounts of different assets do not add up. The payment span records the payment, not the
paid request's status or your tool's outcome; spans are not an accounting record: a trace that a sampler dropped, or
that was not exported, misses its payments.

## Failures

By default, the adapter does not observe mppx's `payment.failed` event: observing it makes mppx buffer the body of a
5xx answer to a paid request (at most 64 KiB and 2 seconds), so with an observer a longer body reaches you cut, with an
`Mppx-Body-Truncated: true` header, and a body whose stream fails makes `fetch` reject. Without it, the adapter changes
nothing you get. A paid request answered with a 5xx, or that failed on the network, then ends as `timeout` once the
challenge's deadline passed, with the payer's own hash; with a reader, the confirm span then records the transaction.
A payment that failed before its credential (the client's policy or spending limits, signing, a failed push send)
records nothing.

`observeFailures: true` adds the `payment.failed` observer, with mppx's buffering: such payments then end at once,
as `pending` with the hash, or as an error.

## Try it locally

A payment can be made and traced on a local [Anvil](https://getfoundry.sh) chain in Tempo mode (`anvil --network
tempo`), with no public network and no funds: Anvil funds its test accounts with pathUSD. The
[charge integration test](https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.1/packages/mpp/test/charge.int.test.ts)
is the complete recipe, with its helpers in
[`tempo-anvil.ts`](https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.1/packages/mpp/test/tempo-anvil.ts): a vitest file
that uses the repository's test helpers, to read rather than to copy as is. Take from it:

- The chain: Anvil started with `--network tempo` and Tempo's chain id (`4217`), with one block mined before the first
  charge (a fresh chain's first block fails Tempo's `validAfter` check), and viem's `tempo` chain with Anvil's URL.
- The paid API, `paidApi()`: an mppx server (`Mppx.create` from `mppx/server`, with `tempo({ recipient, currency,
  account, getClient })`) whose `charge({ amount })` answers each request, served as a function that stands in for
  `fetch`, so no port is opened. With `feePayer: true`, the server sponsors the fee of pull charges.
- The paying client: as in [usage](#usage), with a reader on Anvil.

## Known limits

- Only Tempo `charge` payments are traced, push and pull. Sessions (payment channels and their vouchers),
  subscriptions, the `evm` and `stripe` methods and x402 over mppx are made untraced, with a `diag` warning once per
  method and intent. Only the paying client is traced, not an mppx server.
- Paid MCP tools are not traced: `McpClient.wrap` from `mppx/mcp/client` pays with the methods it is given, and fires
  none of the client's events.
- Payments made with the client's manual APIs (`preparePayment`, `prepareRequest`, `createCredential`) fire no
  outcome event: their payment spans end as `timeout`.
- A 3xx, a 4xx or a final 402 after payment fires no event: the payment ends as `timeout`, although the money may have
  moved; for a push payment, its send span and hash show it.
- A sponsored pull's hash, and with it the confirm span, rest on the server's `reference`. Its verdict is `true`
  only when the mined transaction is the one the payer signed (its sender and nonce fields), so it costs one more
  request to the reader; when that cannot be shown, the payment has no verdict.
- Auto-swap and machine-token routes, whose receipt names another `fundingCurrency`, get no verdict.
- A push payment from a wallet (JSON-RPC) account is sent with `sendCallsSync`: the payment span links to the call
  batch's send span, as checked on Anvil, where viem falls back to `eth_sendTransaction` for a single call; a wallet
  that carries the batch otherwise (several transactions, a user operation) was not checked.
- By default, a 5xx after payment, or a paid request that failed on the network, ends as `timeout` only once the
  challenge's deadline passed, and a payment that failed before its credential records nothing
  ([failures](#failures)). `observeFailures: true` records them at once, but lets mppx buffer and cut 5xx bodies.
- The adapter cancels its copy of the paid response once the `payment.response` observers ran, unless one of them
  started reading it: an observer of yours that waits longer than that before it reads the copy finds it cancelled.
- The limits of `@hashspan/viem`'s confirmations and of the core apply to the confirm span
  ([`@hashspan/viem`](https://github.com/selimaytac/hashspan/tree/@hashspan/mpp@0.1.1/packages/viem#known-limits),
  [`@hashspan/core`](https://github.com/selimaytac/hashspan/tree/@hashspan/mpp@0.1.1/packages/core#known-limits)).

## Compatibility

This package is 0.x and follows mppx, which is 0.x too: it supports one mppx minor line at a time (see
[install](#install)), and a new line raises that range in a minor release of this package. The design is in
[ADR 0029](https://github.com/selimaytac/hashspan/blob/@hashspan/mpp@0.1.1/docs/adr/0029-mpp-payments.md).

## License

Apache-2.0
