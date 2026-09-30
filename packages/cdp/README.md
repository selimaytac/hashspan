# @hashspan/cdp

Trace the transactions your AI agents send with [Coinbase CDP](https://docs.cdp.coinbase.com) server accounts, using
OpenTelemetry.

CDP signs and broadcasts transactions through its API, so no RPC client of yours sees them. This adapter wraps a
`CdpClient` so that each transaction becomes a `send {chainId}` span inside your agent's trace, and, with a reader,
a linked `confirm {chainId}` span with status, gas, fees and revert reason, like
[`@hashspan/viem`](https://github.com/selimaytac/hashspan/tree/main/packages/viem).

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
adapter never picks an RPC endpoint itself.

`withHashspan(cdp, options)` accepts the [`@hashspan/core` options](https://github.com/selimaytac/hashspan/tree/main/packages/core#options)
(address mode, agent identity, redaction hook, ...), `decodeRevertReason` as in `@hashspan/viem`, `reader`, and
`confirmTimeoutMs` (default 120 000 ms).

## Traced

| Call | Recorded on the send span |
|---|---|
| `cdp.evm.sendTransaction` | chain id, from, to, value, nonce, function selector (object or serialized transaction) |
| account `sendTransaction` | the same |
| account `transfer` | ETH: to and value; tokens: the token contract, `transfer` and its selector (arguments with `recordFunctionArguments`) |
| account `swap`, `useSpendPermission` | chain id and from |
| network-scoped accounts (`useNetwork`) | as above; on Base and Ethereum they send through the account itself, elsewhere through the SDK's own viem client, and both are traced once |

Accounts are traced when they come from `createAccount`, `getAccount`, `getOrCreateAccount`, `importAccount` or
`listAccounts`. Networks are mapped to chain ids with `CDP_NETWORK_CHAIN_IDS`; a call on another network, or a
network-scoped account created from an RPC URL, is passed through untraced.

Not traced yet: smart account user operations (`sendUserOperation`), which get their own design; `signTransaction`,
which does not broadcast (send the signed transaction with a client extended by `@hashspan/viem`). Accounts turned
into viem accounts with `toAccount()` are sent through your viem client: extend it with `@hashspan/viem`.

## The SDK's own telemetry

The CDP SDK sends usage and error events to Coinbase by default. It is independent of hashspan; set
`DISABLE_CDP_USAGE_TRACKING=true` and `DISABLE_CDP_ERROR_REPORTING=true` to turn it off.

## License

Apache-2.0
