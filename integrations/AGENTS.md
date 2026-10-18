# integrations

Private tests that run the setups of docs/integrations.md with the third-party libraries they name, against Anvil.
Root rules: [AGENTS.md](../AGENTS.md).

- A workspace of its own with its own lockfile, so those libraries stay out of the main install and of the dependency
  audit and license check; it imports hashspan from source (`vitest.config.ts` alias), so the main install comes
  first: `pnpm install`, `pnpm --dir integrations install`, then `pnpm test:integrations` from the root.
- `test/offline.ts` a setup file that lets only loopback requests through `fetch` and answers AgentKit's analytics
  requests; each test starts its own Anvil with `startAnvil()`
  (`packages/viem/test/start-anvil.ts`), on a port the OS assigns as Anvil binds it
- `test/agentkit-viem.int.test.ts` the AgentKit `ViemWalletProvider` setup; `test/agentkit-langchain.int.test.ts`
  AgentKit's wallet actions as tools of a LangChain agent, with a tool span around each call and a scripted model;
  `test/agentkit-cdp.int.test.ts` the AgentKit CDP wallet providers, against `packages/cdp/test/mock-cdp-api.ts`; `test/goat-viem.int.test.ts` the GOAT
  `viem()` wallet setup; `test/mastra.int.test.ts` the Mastra OpenTelemetry bridge setup, with a scripted model;
  `test/mastra-agent.int.test.ts` runs the complete Mastra example of docs/integrations.md as written;
  `test/openinference-langchain.int.test.ts` and `test/openinference-openai-agents.int.test.ts` the OpenInference
  setups, with scripted models (shared setup in `test/openinference.ts`); `test/smart-account-sdks.int.test.ts` the
  permissionless.js and ZeroDev smart account clients and the permissionless example of docs/integrations.md, through
  the in-process bundler of packages/viem with a stand-in account (`test/smart-account-setup.ts`);
  `test/mcp.int.test.ts` an MCP tool that sends, with the agent and the stdio server as child processes run with
  tsx's loader (from the main install; it maps `@hashspan/*` to their sources through `tsconfig.json` paths) that
  export over OTLP to a receiver in the test: the v1 SDK without and with
  OpenInference's MCP instrumentation (`test/mcp-v1/`), and the v2 example of the docs as written;
  `test/hardhat.int.test.ts` the Hardhat 3 examples of the docs as written, run with the Hardhat CLI in the project
  `test/hardhat/` on Hardhat's in-process network (no Anvil), with a control script in `test/hardhat/scripts/`; the
  project's artifacts are committed and every run passes `--no-compile`, since a build downloads solc (see
  `test/hardhat/hardhat.config.ts`); `test/erpc.int.test.ts` the agent of the eRPC section as written, with the undici
  instrumentation, through the pinned eRPC binary of `scripts/install-erpc.sh` (`make tools`) in front of Anvil on
  127.0.0.1, with the `erpc.yaml` block of the docs changed only in its addresses, and a control without the
  instrumentation (`test/erpc/no-undici.ts`). All three export over OTLP to `test/otlp-receiver.ts`, which also reads
  the protobuf that eRPC's exporter sends
- `test/readme/` holds the `#region readme` files of doc examples that need these libraries, as
  `packages/*/test/readme/` does for the others: the typecheck compiles them and `packages/core/test/docs.test.ts`
  matches them with the docs
- The integrations job also reports the audit and the licenses of this workspace without failing (they never ship)
- `.github/workflows/integrations.yml` runs them on pull requests that touch `packages/` or `integrations/`, and
  weekly with every dependency of `integrations/` updated to the newest release within its range
