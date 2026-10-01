# @hashspan/cdp

Trace the transactions your AI agents send with [Coinbase CDP](https://docs.cdp.coinbase.com) server accounts, using
OpenTelemetry.

CDP signs and broadcasts transactions through its API, so no RPC client of yours sees them. This adapter wraps a
`CdpClient` so that each transaction becomes a `send {chainId}` span inside your agent's trace, and, with a reader,
a linked `confirm {chainId}` span with status, gas, fees and revert reason, like
[`@hashspan/viem`](https://github.com/selimaytac/hashspan/tree/@hashspan/cdp@0.3.1/packages/viem).

## Install

```sh
npm install @hashspan/cdp @coinbase/cdp-sdk @opentelemetry/api viem
```

Requires Node.js 22.3 or later. Bring your own OpenTelemetry SDK and exporter.

## Usage

```ts
import { CdpClient } from '@coinbase/cdp-sdk';
import { withHashspan } from '@hashspan/cdp';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

const cdp = new CdpClient();
// Wraps the client in place; call it once, right after creating the client.
const hashspan = withHashspan(cdp, {
  reader: createPublicClient({ chain: baseSepolia, transport: http() }),
});

const account = await cdp.evm.getOrCreateAccount({ name: 'treasury' });
await account.sendTransaction({ network: 'base-sepolia', transaction: { to, value } }); // send + confirm spans

// Before a short-lived process exits:
await hashspan.flush();
```

`reader` is a viem public client, or a function `(chainId) => client | undefined` for several chains. Confirmations
run in the background through it and never delay your call. Without a reader, only send spans are recorded: the
adapter never picks an RPC endpoint itself. The exception is `waitForTransactionReceipt` on a network-scoped
account, which records a confirm span from the receipt it returns, without a revert reason.

`flush({ timeoutMs })` (default 10 000 ms) waits for every confirm span the adapter still has open, from the reader or
from such a wait, and ends what is left as `timeout` if it cannot wait longer. Call it before a short-lived process
exits.

`withHashspan(cdp, options)` accepts the [`@hashspan/core` options](https://github.com/selimaytac/hashspan/tree/@hashspan/cdp@0.3.1/packages/core#options)
(address mode, agent identity, redaction hook, ...), `decodeRevertReason` as in `@hashspan/viem`, `tracker`, `reader`,
and `confirmTimeoutMs` (default 120 000 ms). Call it once per client: a second call returns the first handle, ignores
its options and logs a `diag` warning.

### With `@hashspan/viem`

If your agent also waits for receipts with a viem client extended by `@hashspan/viem`, give both the same tracker, so
that a transaction gets one confirm span, linked to its send span, however many parts of your code wait for it:

```ts
import { createTxTracker } from '@hashspan/core';
import { withHashspan as withViemHashspan } from '@hashspan/viem';

const tracker = createTxTracker({ agent: { name: 'treasury-bot' } });
const hashspanViem = withViemHashspan({ tracker });
const reader = createPublicClient({ chain: baseSepolia, transport: http() }).extend(hashspanViem);
const hashspanCdp = withHashspan(cdp, { tracker, reader });

// At shutdown, flush both:
await Promise.all([hashspanCdp.flush(), hashspanViem.flush()]);
```

A reader client whose chain differs from the transaction's, given directly or returned by a reader function, is not
used; a `diag` warning says so.

## Traced

| Call | Recorded on the send span |
|---|---|
| `cdp.evm.sendTransaction` | chain id, from, to, value, nonce, function selector (object or serialized transaction) |
| account `sendTransaction` | the same |
| account `transfer` | ETH: to and value; tokens: the token contract, `transfer` and its selector (arguments with `recordFunctionArguments`) |
| account `swap`, `useSpendPermission` | chain id and from |
| `execute()` of a quote from `cdp.evm.createSwapQuote` or account `quoteSwap` | chain id and from (the taker) |
| network-scoped accounts (`useNetwork`) | as above; on Base and Ethereum they send through the account itself, elsewhere through the SDK's own viem client, and both are traced once |
| network-scoped `waitForTransactionReceipt` | without a reader: a confirm span with status, block, gas and fees, but no revert reason; with a reader, the background confirmation records it |

Accounts are traced when they come from `createAccount`, `getAccount`, `getOrCreateAccount`, `importAccount`,
`updateAccount` or `listAccounts`. Networks are mapped to chain ids with `CDP_NETWORK_CHAIN_IDS`; a call on another network, or a
network-scoped account created from an RPC URL, is passed through untraced, with a `diag` warning once per network
(an RPC URL is never logged, as it can contain an API key).

Each call gets its own send span: retrying a call with the same `idempotencyKey` records a second send span, even
when CDP returns the transaction of the first attempt; the confirm span is shared.

Not traced yet: smart account user operations (`sendUserOperation`, and quotes created for a smart account), which
get their own design; EIP-7702 delegated accounts; Solana (`cdp.solana`); `requestFaucet`, which Coinbase sends; `signTransaction`,
which does not broadcast (send the signed transaction with a client extended by `@hashspan/viem`). Accounts turned
into viem accounts with `toAccount()` are sent through your viem client: extend it with `@hashspan/viem`.

## The SDK's own telemetry

The CDP SDK sends usage and error events to Coinbase by default. It is independent of hashspan; set
`DISABLE_CDP_USAGE_TRACKING=true` and `DISABLE_CDP_ERROR_REPORTING=true` to turn it off.

## License

Apache-2.0
