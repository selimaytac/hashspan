# integrations

Private tests that run the setups of docs/integrations.md with the third-party libraries they name, against Anvil.
Root rules: [AGENTS.md](../AGENTS.md).

- A workspace of its own with its own lockfile, so those libraries stay out of the main install and of the dependency
  audit and license check; it imports hashspan from source (`vitest.config.ts` alias), so the main install comes
  first: `pnpm install`, `pnpm --dir integrations install`, then `pnpm test:integrations` from the root.
- `test/offline.ts` a setup file that lets only loopback requests through `fetch` and answers AgentKit's analytics
  requests; `test/agentkit-viem.int.test.ts` the AgentKit `ViemWalletProvider` setup
- `.github/workflows/integrations.yml` runs them on pull requests that touch `packages/` or `integrations/`, and
  weekly with every dependency of `integrations/` updated to the newest release within its range
