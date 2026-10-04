# packages/x402

Adapter for x402 payments (ADR 0013). Root rules: [AGENTS.md](../../AGENTS.md).

- `src/index.ts` `withHashspan(client, { reader })` registers hooks on an `x402Client`: each payment becomes a
  `payment` span (no send span: the facilitator sends); confirmations go through `@hashspan/viem`'s `watch()`.
  Hooks never throw or return a value; payments without a response end as `timeout`, bounded in time and number.
  With a reader, the settlement is checked to carry the payment (ADR 0017).
- `test/fake-x402.ts` a real `x402Client` with a signing-free scheme and a fake paid API, offline; the identities
  of SDK objects across hooks, which the adapter relies on, are asserted in `test/adapter.test.ts`
- `test/settlement.int.test.ts` settles real EIP-3009 payments on Anvil through the SDK's resource server and
  facilitator, with `test/token/TestUsd.sol` (compiled into `test-usd.ts` by `test/token/compile.mjs`);
  `.github/workflows/x402-sdk.yml` runs the x402 tests weekly against both ends of the SDK peer range
- `test/rpc-faults.int.test.ts` puts the reader behind the viem tests' fault proxy (`../viem/test/fault-proxy.ts`)
- `test/permit2-settlement.int.test.ts` settles real Permit2 `exact` and `upto` payments with the same token, with
  Permit2 and the x402 proxies installed from `test/permit2/contracts.ts` (copied from Base Sepolia by
  `test/permit2/fetch.mjs`, never run in tests)
- `test/hostile-input.test.ts` applies the hostile-input table (`../core/test/hostile.ts`, ADR 0025) to the hooks, with
  hostile requirements, payloads, settlement responses and receipts, and to the options and the client; a new hook adds
  rows there
