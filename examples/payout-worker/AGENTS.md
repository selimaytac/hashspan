# examples/payout-worker

A payout worker, not an agent, traced with hashspan. Root rules: [AGENTS.md](../../AGENTS.md).

- `src/worker.ts` sends each payout in a `payout <id>` span through a viem client extended with background
  confirmation; `src/chain.ts` holds the payouts and places a refusing contract on Anvil; `src/telemetry.ts` is a
  plain OpenTelemetry setup; `src/main.ts` runs it against `RPC_URL` (default `http://127.0.0.1:8545`).
- `test/worker.int.test.ts` runs the worker on Anvil in CI: one trace per payout, send and confirm spans under each
  job span, no `gen_ai.*` attributes, the refused payout's failed send, and the confirmation samples.
- `test/skill.int.test.ts` applies `skills/hashspan/SKILL.md` to `test/skill-fixture/`, the worker before hashspan
  as a service that never waits for receipts, runs it on Anvil, stops it with SIGTERM and checks a send and a
  confirm span under each job span (helper: `packages/viem/test/apply-skill.ts`).
- The same packages and versions as `examples/ai-sdk-agent`, without the AI SDK; `@opentelemetry/sdk-node` is a dev
  dependency for the skill test, since the skill installs it.
