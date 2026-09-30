# 0012. Coinbase CDP adapter for server accounts

- Status: accepted
- Date: 2026-09-30
- Accepted: 2026-09-30, after comparing the implementation (`packages/cdp`); the decision below records where it
  differs from the proposal.

## Context

The Coinbase Developer Platform SDK (`@coinbase/cdp-sdk`) signs **and** broadcasts transactions through its REST API,
so no user transport sees them and `@hashspan/viem` cannot trace them (ADR 0001). It is the default wallet of several
agent toolkits. Relevant facts, from the SDK source (1.57):

- `cdp.evm.sendTransaction`, and on server accounts `sendTransaction`, `transfer`, `swap` and `useSpendPermission`,
  return `{ transactionHash }`. `transfer`, `swap` and `useSpendPermission` do not go through `sendTransaction`.
- Networks are names (`base`, `base-sepolia`, ...); the SDK's name to chain id map is not exported. CDP fills nonce,
  gas and fees when they are omitted, so the nonce is often unknown when the call is made.
- There is no receipt helper for server accounts, except on network-scoped accounts (`useNetwork`), which carry
  `waitForTransactionReceipt`.
- The SDK has no hook or middleware API. `cdp.evm` is a class instance; accounts are plain objects, created anew by
  every factory call.
- Smart accounts send ERC-4337 user operations, identified by a `userOpHash`; the transaction hash only exists once the
  bundle is mined, and one bundle can carry many operations.
- Accounts turned into viem accounts (`toAccount`) broadcast through the user's viem client, which `@hashspan/viem`
  covers. Network-scoped accounts on chains other than Base and Ethereum broadcast through a viem client the SDK
  creates internally, which the user cannot extend.

## Decision

- A new package, `@hashspan/cdp`, with `withHashspan(cdp, options)`. Peer dependencies: `@coinbase/cdp-sdk`,
  `@opentelemetry/api`, `viem`. `viem` is a peer, not a regular dependency, because the `reader` is the user's viem
  client and must be of the same viem the adapter uses to confirm through it; the CDP SDK depends on viem itself.
  AGENTS.md allows such a peer for adapters.
- **Wrapping per instance.** It installs wrappers as own properties on `cdp.evm` for `sendTransaction` and the server
  account factories (`createAccount`, `getAccount`, `getOrCreateAccount`, `importAccount`, `updateAccount`,
  `listAccounts`), and wraps each account they return (`sendTransaction`, `transfer`, `swap`, `quoteSwap`,
  `useSpendPermission`, `useNetwork`). `execute()` of a swap quote, from `cdp.evm.createSwapQuote` or `quoteSwap`, is
  traced too, except for quotes created for a smart account, which send a user operation. A
  network-scoped account's `sendTransaction` and `transfer` are traced by the adapter only on chains where the SDK
  sends through its internal viem client; on Base and Ethereum they call the wrapped account, which traces them, so
  each transaction gets one send span. The scoped `waitForTransactionReceipt` is not wrapped: confirmations come from
  the reader. It never patches prototypes or the SDK's HTTP client. Wrapping is idempotent, happens in place, and
  `withHashspan()` returns a handle with `flush()`; a second call on the same client returns the first handle and
  logs a `diag` warning, since its options cannot take effect.
- **Send span.** Started when the call starts (ADR 0009), ended with `transactionHash`, or failed with the error.
  Recorded: chain id from our own network name map, exported as `CDP_NETWORK_CHAIN_IDS` (a call on an unknown
  network, or on a network-scoped account created from an RPC URL, is not traced, with a `diag` warning once per
  network name that never includes an RPC URL). A unit test compares the map and the chains on which network-scoped
  accounts send through the CDP API with the installed SDK, which does not export them, `from` (the account address), and
  for `sendTransaction` `to`, `value`, `nonce` and the function selector from the request, parsing a serialized
  transaction with viem when one is given. A token `transfer` is recorded as a call to the token contract.
- **Confirm span, from a reader.** Confirmation needs a viem `PublicClient` for the chain, passed as `reader`.
  `@hashspan/viem` gains `watch(client, { hash })` on the `withHashspan()` result: it confirms a transaction sent
  elsewhere through `client` in the background, like background confirmation (ADR 0002), with revert reasons
  (ADR 0005), replacements (ADR 0008) and `flush()` (ADR 0010). `@hashspan/cdp` uses it. Without a reader, only send
  spans are recorded; the adapter never picks an RPC endpoint itself. A reader client, given directly or returned by a
  function `(chainId) => client` that serves several chains, is used only when its chain matches the transaction's;
  otherwise a `diag` warning is logged. The `tracker` option is shared with `@hashspan/viem`: with the same tracker, the user's own receipt waits
  and the adapter's background confirmation share one confirm span (ADR 0007), and the user flushes both handles.
- **What is never read or recorded.** The client's configuration, API key, wallet secret, generated JWTs and request
  bodies. Errors follow ADR 0006. A failed send records the CDP API's
  error type (`APIError.errorType`, e.g. `insufficient_balance`) as `error.type`, through a core option that accepts
  only short identifiers; `exception.type` stays the class name.
- **Retries.** Each call gets its own send span, so a retry with the same `idempotencyKey` records a second one.
- **Not traced in this step.** Smart account user operations (including swap quotes created for a smart account),
  which need a new identifier in the core and the schema and get their own ADR; EIP-7702 delegated accounts
  (`toEvmDelegatedAccount` returns a smart account); Solana (`cdp.solana`); `requestFaucet`, which Coinbase sends;
  `signTransaction`, which does not broadcast; and `toAccount()` accounts, which broadcast through the user's viem
  client.
- The SDK's own usage tracking and error reporting are left as they are; the README names the environment variables
  that turn them off.
- Tests run offline: the client's `basePath` points at a local mock of the CDP API, with throwaway keys, and the
  mock broadcasts on Anvil so that confirmations use real receipts. A guard fails the tests if any request leaves
  localhost.

## Consequences

- CDP server account transactions appear in the agent's trace like viem ones, with the same attributes and rules.
- Adding `watch()` makes the receipt handling of `@hashspan/viem` reusable by any adapter whose send path yields a
  hash but no receipt (x402 next).
- Wrapping depends on the SDK's object shapes, which are not a public contract; CI tests the lowest version of the
  peer range, and a weekly workflow (`cdp-sdk-latest.yml`) tests the newest release within it.
- AgentKit keeps its `CdpClient` private, so it needs a separate wallet provider wrapper; not part of this step.
