# integrations

Private tests that run the setups of docs/integrations.md with the third-party libraries they name, against Anvil.
Root rules: [AGENTS.md](../AGENTS.md).

- A workspace of its own with its own lockfile, so those libraries stay out of the main install and of the dependency
  audit and license check; it imports hashspan from source (`vitest.config.ts` alias), so the main install comes
  first: `pnpm install`, `pnpm --dir integrations install`, then `pnpm test:integrations` from the root.
- `test/offline.ts` a setup file that lets only loopback requests through `fetch` and answers AgentKit's analytics
  requests; each test starts its own Anvil on a free port (`packages/viem/test/free-port.ts`)
- `test/agentkit-viem.int.test.ts` the AgentKit `ViemWalletProvider` setup; `test/agentkit-cdp.int.test.ts` the
  AgentKit CDP wallet providers, against `packages/cdp/test/mock-cdp-api.ts`; `test/goat-viem.int.test.ts` the GOAT
  `viem()` wallet setup; `test/mastra.int.test.ts` the Mastra OpenTelemetry bridge setup, with a scripted model;
  `test/openinference-langchain.int.test.ts` and `test/openinference-openai-agents.int.test.ts` the OpenInference
  setups, with scripted models (shared setup in `test/openinference.ts`)
- The integrations job also reports the audit and the licenses of this workspace without failing (they never ship)
- `.github/workflows/integrations.yml` runs them on pull requests that touch `packages/` or `integrations/`, and
  weekly with every dependency of `integrations/` updated to the newest release within its range
