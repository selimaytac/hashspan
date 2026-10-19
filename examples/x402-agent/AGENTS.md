# examples/x402-agent

An AI SDK agent with a scripted model (no API key) that sends a transaction with `@hashspan/viem` and pays an x402
API with `@hashspan/x402`. Root rules: [AGENTS.md](../../AGENTS.md).

- `src/paid-api.ts` serves the paid API with Hono and `@x402/hono` on `127.0.0.1` (a free port unless
  `PAID_API_PORT`), with an in-process `x402Facilitator` settling from Anvil's first account; `src/chain.ts` deploys
  Test USD from `packages/x402/test/token/test-usd.ts` (no Solidity toolchain) and makes a fresh agent account per
  run; `src/payments.ts` is the agent's `x402Client` with a reader and spend controls. One `createTxTracker()` with
  the agent identity is shared by both adapters.
- `test/agent.int.test.ts` runs `src/main.ts` with tsx in a process of its own on a fresh Anvil, with
  `test/tsconfig.run.json` mapping the hashspan packages to their sources (no build needed), and checks the trace it
  exports over OTLP/JSON to `startReceiver()` of `packages/viem/test/apply-skill.ts`: send and confirm spans under
  `execute_tool tip_author`, a settled and verified payment span and its linked confirm span under
  `execute_tool buy_report`, one trace. A change to the trace changes the README's tree too.
- The `@x402/*` packages are pinned to one minor (`~2.28.0`): `@x402/hono` depends on `@x402/core` `~2.28.0`, and a
  second copy of core would split the server's and the facilitator's types.
- The README's Base Sepolia section is not run in CI and says so; tests never use a public network.
