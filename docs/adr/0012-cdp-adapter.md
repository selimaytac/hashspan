# 0012. Coinbase CDP adapter for server accounts

- Status: proposed
- Date: 2026-09-30

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
- Accounts turned into viem accounts (`toAccount`) broadcast through viem, and `useNetwork` on chains other than Base
  and Ethereum broadcasts through viem too: those paths are already covered by `@hashspan/viem`.

## Decision

- A new package, `@hashspan/cdp`, with `withHashspan(cdp, options)`. Peer dependencies: `@coinbase/cdp-sdk`,
  `@opentelemetry/api`, `viem`.
- **Wrapping per instance.** It installs wrappers as own properties on `cdp.evm` for `sendTransaction` and the server
  account factories (`createAccount`, `getAccount`, `getOrCreateAccount`, `listAccounts`), and wraps each account they
  return (`sendTransaction`, `transfer`, `swap`, `useSpendPermission`, `useNetwork` and the network-scoped account's
  `sendTransaction` and `waitForTransactionReceipt`). It never patches prototypes or the SDK's HTTP client. Wrapping is
  idempotent and returns the same client.
- **Send span.** Started when the call starts (ADR 0009), ended with `transactionHash`, or failed with the error.
  Recorded: chain id from our own network name map (a call on an unknown network is not traced), `from` (the account
  address), and for `sendTransaction` `to`, `value`, `nonce` and the function selector from the request, parsing a
  serialized transaction with viem when one is given.
- **Confirm span, from a reader.** Confirmation needs a viem `PublicClient` for the chain, passed as `reader`.
  `@hashspan/viem` gains `watch(client, { hash })` on the `withHashspan()` result: it confirms a transaction sent
  elsewhere through `client` in the background, like background confirmation (ADR 0002), with revert reasons
  (ADR 0005), replacements (ADR 0008) and `flush()` (ADR 0010). `@hashspan/cdp` uses it. Without a reader, only send
  spans are recorded; the adapter never picks an RPC endpoint itself.
- **Not traced in this step.** Smart account user operations, which need a new identifier in the core and the schema
  and get their own ADR; `signTransaction`, which does not broadcast; and paths that broadcast through viem.
- The SDK's own usage tracking and error reporting are left as they are; the README names the environment variables
  that turn them off.
- Tests run offline: the client's `basePath` points at a local mock of the CDP API, with throwaway keys.

## Consequences

- CDP server account transactions appear in the agent's trace like viem ones, with the same attributes and rules.
- Adding `watch()` makes the receipt handling of `@hashspan/viem` reusable by any adapter whose send path yields a
  hash but no receipt (x402 next).
- Wrapping depends on the SDK's object shapes, which are not a public contract; tests pin the supported SDK range.
- AgentKit keeps its `CdpClient` private, so it needs a separate wallet provider wrapper; not part of this step.
