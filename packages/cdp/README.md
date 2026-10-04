# @hashspan/cdp

Trace the transactions your AI agents send with [Coinbase CDP](https://docs.cdp.coinbase.com) server accounts, and
the user operations of CDP smart accounts, using OpenTelemetry.

CDP signs and broadcasts transactions through its API, so no RPC client of yours sees them. This adapter wraps a
`CdpClient` so that each transaction becomes a `send {chainId}` span inside your agent's trace, and, with a reader,
a linked `confirm {chainId}` span with status, gas, fees and revert reason, like
[`@hashspan/viem`](https://github.com/selimaytac/hashspan/tree/@hashspan/cdp@0.11.0/packages/viem).

## Install

```sh
npm install @hashspan/cdp @coinbase/cdp-sdk @opentelemetry/api viem
```

Requires Node.js 22.3 or later. From a CommonJS module it needs Node.js 22.12, because the CDP SDK's CommonJS build loads an ES module; ES modules work from 22.3. Bring your own [OpenTelemetry SDK and exporter](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/).

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
adapter never picks an RPC endpoint itself. The exceptions are the SDK's waits: `waitForTransactionReceipt` on a
network-scoped account, which records a confirm span from the receipt it returns, without a revert reason, and
`waitForUserOperation` ([Smart accounts](#smart-accounts)).

`flush({ timeoutMs })` (default 10 000 ms) waits for every confirm span the adapter still has open, from the reader or
from such a wait, and ends what is left as `timeout` if it cannot wait longer (a user operation CDP already reported
`complete` ends with what is known). Call it before a short-lived process exits.

`withHashspan(cdp, options)` accepts the [`@hashspan/core` options](https://github.com/selimaytac/hashspan/tree/@hashspan/cdp@0.11.0/packages/core#options)
(address mode, agent identity, redaction hook, ...), `decodeRevertReason` and `maxBackgroundConfirmations` as in
`@hashspan/viem` (the limit applies to confirmations through the reader), `tracker`, `reader`, and `confirmTimeoutMs`
(default 120 000 ms; for a user operation CDP reported complete, it also bounds the poll for its bundle receipt). With
`tracker`, the core options are not used: they configure the tracker the adapter would otherwise create. Call it once
per client: a second call returns the first handle, ignores its options and logs a `diag` warning.

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
used; a `diag` warning says so. A reader client without a chain is used for every chain.

### Smart accounts

Smart accounts send ERC-4337 user operations, which CDP's bundler puts into a bundle transaction. Each operation
becomes a `send {chainId}` span, ended when CDP returns its `userOpHash`, and, when your code waits for it with
`waitForUserOperation`, a linked `confirm {chainId}` span:

```ts
const owner = await cdp.evm.getOrCreateAccount({ name: 'owner' });
const smartAccount = await cdp.evm.getOrCreateSmartAccount({ name: 'treasury', owner });

const { userOpHash } = await smartAccount.sendUserOperation({
  network: 'base-sepolia',
  calls: [{ to, value, data: '0x' }],
}); // send span
await smartAccount.waitForUserOperation({ userOpHash }); // confirm span
```

The spans carry `blockchain.user_operation.*` attributes instead of a transaction's sender, nonce and fee
([semantic conventions](https://github.com/selimaytac/hashspan/blob/@hashspan/cdp@0.11.0/docs/semconv.md)):

- CDP reports `complete` with the bundle transaction's hash, or `failed` without a reason, which ends the confirm
  span as an error with `error.type` `failed`. A wait that gives up (the SDK's `TimeoutError`) ends it as `timeout`.
- `complete` does not say whether the operation's calls succeeded: a bundle can be mined while an operation in it
  reverts. With a `reader` for the chain, the adapter reads the bundle's receipt and records the operation's
  `UserOperationEvent`: success (a reverted operation ends with `error.type` `reverted`), gas used, cost, nonce,
  paymaster and EntryPoint. Without one, or if the bundle receipt is not found within `confirmTimeoutMs`, the confirm
  span records the bundle transaction's hash only.
- The bundle transaction's status and fee are not recorded: they cover every operation in the bundle.
- Without a wait, only the send span is recorded, with or without a reader. A wait names no network: it is traced
  when the operation was sent through the same client, or on a network-scoped smart account.
- A tracker from a `@hashspan/core` without user operations records none: they are passed on untraced, with a
  `diag` warning.

## Traced

While a traced call runs, its send span is the active span, so spans of the CDP API request that your HTTP
instrumentation creates nest under it.

| Call | Recorded on the send span |
|---|---|
| `cdp.evm.sendTransaction` | chain id, from, to, value, nonce, function selector (object or serialized transaction) |
| account `sendTransaction` | the same |
| account `transfer` | from; ETH: to and value; tokens: the token contract when it is given by address (not for a named token such as `'usdc'`), `transfer` and its selector (arguments with `recordFunctionArguments`) |
| account `swap`, `useSpendPermission` | chain id and from |
| `execute()` of a quote from `cdp.evm.createSwapQuote` or account `quoteSwap` | chain id and from (the taker) |
| network-scoped accounts (`useNetwork`) | as above; on Base and Ethereum they send through the account itself, elsewhere through the SDK's own viem client, and both are traced once |
| network-scoped `waitForTransactionReceipt` | without a reader: a confirm span with status, block, gas and fees, but no revert reason, and no fees for a flashblocks preconfirmation (a receipt with a zero block hash, whose fee can be another transaction's). A replacement the SDK's viem client reports through `onReplaced` (same sender and nonce) is attributed to the mined transaction; for that, the adapter adds its own `onReplaced`, which calls yours, and passes `{ transactionHash }` on as `{ hash, onReplaced }`. A receipt of another hash that viem did not report ends the confirm span with `error.type` `_OTHER`. With a reader, the background confirmation records it from the sealed receipt |
| smart account `sendUserOperation`, `cdp.evm.sendUserOperation`, `cdp.evm.prepareAndSendUserOperation` | user operation: chain id, hash, sender (the smart account) and the number of calls |
| smart account `transfer`, `swap`, `useSpendPermission`; `execute()` of a quote for a smart account (`cdp.evm.createSwapQuote` with `smartAccount`, or smart account `quoteSwap`); `cdp.evm.createSpendPermission`, `cdp.evm.revokeSpendPermission` | user operation: chain id, hash and sender |
| network-scoped smart accounts (`useNetwork`) | as above, each traced once |
| `waitForUserOperation` (`cdp.evm`, smart accounts, network-scoped smart accounts) | a confirm span: the bundle transaction's hash; with a reader, the operation's outcome and cost from its `UserOperationEvent` |

Accounts are traced when they come from `createAccount`, `getAccount`, `getOrCreateAccount`, `importAccount`,
`updateAccount` or `listAccounts`, and smart accounts when they come from `createSmartAccount`, `getSmartAccount`,
`getOrCreateSmartAccount` or `updateSmartAccount` (`listSmartAccounts` returns records without methods). Networks are mapped to chain ids with `CDP_NETWORK_CHAIN_IDS`; a call on another network, or a
network-scoped account created from an RPC URL, is passed through untraced, with a `diag` warning once per network
(an RPC URL is never logged, as it can contain an API key).

Each call gets its own send span: retrying a call with the same `idempotencyKey` records a second send span, even
when CDP returns the transaction of the first attempt; the confirm span is shared.

## Known limits

- Not traced: EIP-7702 delegated accounts; Solana (`cdp.solana`); `requestFaucet`, which Coinbase sends;
  `signTransaction`, which does not broadcast.
- Accounts turned into viem accounts with `toAccount()` are sent through your viem client: extend it with
  `@hashspan/viem`, whose own limits then apply
  ([`@hashspan/viem` known limits](https://github.com/selimaytac/hashspan/tree/@hashspan/cdp@0.11.0/packages/viem#known-limits)).
- Networks without a chain id in `CDP_NETWORK_CHAIN_IDS`, and network-scoped accounts created from an RPC URL, are
  passed through untraced, as are accounts that do not come from the factories listed under [traced](#traced).
- Without a `reader`, only send spans are recorded, except for the SDK's waits; a network-scoped
  `waitForTransactionReceipt` then records no revert reason, and no fees for a flashblocks preconfirmation
  ([usage](#usage), [traced](#traced)).
- A user operation gets a confirm span only from `waitForUserOperation`; without a reader it records only the bundle
  transaction's hash, and the bundle transaction's status and fee are never recorded ([smart accounts](#smart-accounts)).
- A retry with the same `idempotencyKey` records a second send span ([traced](#traced)).
- The limits of the core apply too
  ([`@hashspan/core` known limits](https://github.com/selimaytac/hashspan/tree/@hashspan/cdp@0.11.0/packages/core#known-limits)).

## The SDK's own telemetry

The CDP SDK sends usage and error events to Coinbase by default. It is independent of hashspan; set
`DISABLE_CDP_USAGE_TRACKING=true` and `DISABLE_CDP_ERROR_REPORTING=true` to turn it off.

## License

Apache-2.0
