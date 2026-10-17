# examples/ai-sdk-agent

An AI SDK agent with a scripted model (no API key), run by `make demo`. Root rules: [AGENTS.md](../../AGENTS.md).

- Its `test/*.int.test.ts` runs the agent against Anvil in CI, so the example cannot silently break;
  `test/demo-script.test.ts` tests `scripts/demo.sh`, which starts a fresh Anvil or fails, waiting for Anvil's own
  "Listening on" line rather than probing the port.
- `src/base-sepolia.ts` (behind `make demo-base-sepolia`) runs it on the testnet with a key from the environment,
  tested against an Anvil that reports chain id 84532.
- `test/skill.int.test.ts` applies `skills/hashspan/SKILL.md` to `test/skill-fixture/`, the agent before hashspan
  (AI SDK telemetry on, no OpenTelemetry SDK), runs it on Anvil until it exits and checks a send and a confirm span
  under each `execute_tool` span; `@opentelemetry/sdk-node` is a dev dependency for it, since the skill installs it.
