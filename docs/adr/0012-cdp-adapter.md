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
  `@opentelemetry/api`, `viem`.
- **Wrapping per instance.** It installs wrappers as own properties on `cdp.evm` for `sendTransaction` and the server
  account factories (`createAccount`, `getAccount`, `getOrCreateAccount`, `importAccount`, `listAccounts`), and
  wraps each account they return (`sendTransaction`, `transfer`, `swap`, `useSpendPermission`, `useNetwork`). A
  network-scoped account's `sendTransaction` and `transfer` are traced by the adapter only on chains where the SDK
  sends through its internal viem client; on Base and Ethereum they call the wrapped account, which traces them, so
  each transaction gets one send span. The scoped `waitForTransactionReceipt` is not wrapped: confirmations come from
  the reader. It never patches prototypes or the SDK's HTTP client. Wrapping is idempotent, happens in place, and
  `withHashspan()` returns a handle with `flush()`.
- **Send span.** Started when the call starts (ADR 0009), ended with `transactionHash`, or failed with the error.
  Recorded: chain id from our own network name map, exported as `CDP_NETWORK_CHAIN_IDS` (a call on an unknown
  network, or on a network-scoped account created from an RPC URL, is not traced), `from` (the account address), and
  for `sendTransaction` `to`, `value`, `nonce` and the function selector from the request, parsing a serialized
  transaction with viem when one is given. A token `transfer` is recorded as a call to the token contract.
- **Confirm span, from a reader.** Confirmation needs a viem `PublicClient` for the chain, passed as `reader`.
  `@hashspan/viem` gains `watch(client, { hash })` on the `withHashspan()` result: it confirms a transaction sent
  elsewhere through `client` in the background, like background confirmation (ADR 0002), with revert reasons
  (ADR 0005), replacements (ADR 0008) and `flush()` (ADR 0010). `@hashspan/cdp` uses it. Without a reader, only send
  spans are recorded; the adapter never picks an RPC endpoint itself.
- **Not traced in this step.** Smart account user operations, which need a new identifier in the core and the schema
  and get their own ADR; `signTransaction`, which does not broadcast; and `toAccount()` accounts, which broadcast
  through the user's viem client.
- The SDK's own usage tracking and error reporting are left as they are; the README names the environment variables
  that turn them off.
- Tests run offline: the client's `basePath` points at a local mock of the CDP API, with throwaway keys, and the
  mock broadcasts on Anvil so that confirmations use real receipts. A guard fails the tests if any request leaves
  localhost.

## Consequences

- CDP server account transactions appear in the agent's trace like viem ones, with the same attributes and rules.
- Adding `watch()` makes the receipt handling of `@hashspan/viem` reusable by any adapter whose send path yields a
  hash but no receipt (x402 next).
- Wrapping depends on the SDK's object shapes, which are not a public contract; tests pin the supported SDK range.
- AgentKit keeps its `CdpClient` private, so it needs a separate wallet provider wrapper; not part of this step.
