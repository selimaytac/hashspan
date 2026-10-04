# hashspan

**Trace your AI agents' on-chain transactions with OpenTelemetry.**

hashspan turns every transaction an agent sends into spans, keyed by the transaction hash, inside the agent's
own OpenTelemetry trace.

[![CI](https://github.com/selimaytac/hashspan/actions/workflows/ci.yml/badge.svg)](https://github.com/selimaytac/hashspan/actions/workflows/ci.yml)
[![npm @hashspan/core](https://img.shields.io/npm/v/@hashspan/core?label=%40hashspan%2Fcore)](https://www.npmjs.com/package/@hashspan/core)
[![npm @hashspan/viem](https://img.shields.io/npm/v/@hashspan/viem?label=%40hashspan%2Fviem)](https://www.npmjs.com/package/@hashspan/viem)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **Status: early (0.x).** Published with npm provenance; span and attribute names are still marked `development`
> ([semantic conventions](docs/semconv.md)) and may change in minor releases. Feedback on the schema is very welcome;
> see the [roadmap](docs/roadmap.md).

When an AI agent sends a transaction, the agent trace usually stops at the tool call. Whether the transaction was
mined, reverted, or what it cost lives somewhere else. hashspan closes that gap: each transaction becomes a
`send` / `confirm` span pair **inside the agent's own trace**, with status, gas, L2 fees and the agent identity
attached, and it's exported to the backend you already use (Jaeger, Grafana Tempo, Langfuse, Honeycomb, ...).

![An AI SDK agent run in Jaeger: each tool call contains the send and confirm spans of its transaction, and the reverted withdrawal is marked as an error](docs/images/jaeger-trace.png)

<sub>The [example agent](examples/ai-sdk-agent) in Jaeger: a vendor payment and a withdrawal that reverts with a
decoded custom error.</sub>

## Why

- **No new dashboard.** It's a library that emits standard OpenTelemetry spans. Your existing backend is the UI.
- **Agent-aware.** Transaction spans nest under your framework's agent/tool spans and carry `gen_ai.agent.id`.
- **Real cost.** Fees include the L1 data fee on OP-stack chains such as Base.
- **Metrics too.** Send and confirmation latency and fees are also recorded as histograms, and `traceTransport()` can
  add a span per JSON-RPC request ([semantic conventions](docs/semconv.md)).
- **Small footprint.** `@hashspan/core` has one peer dependency, `@opentelemetry/api`; `@hashspan/viem` adds `viem`,
  the library it instruments. It never signs or broadcasts transactions.
- **Privacy by design.** Calldata arguments and error messages are opt-in, and addresses can be hashed or dropped
  ([ADR 0004](docs/adr/0004-privacy-defaults.md), [ADR 0006](docs/adr/0006-error-privacy.md)). This limits what
  your backend stores; it is not anonymity, since the transaction hash resolves to the parties on chain
  ([privacy notes](packages/core#privacy-notes)).

## Packages

| Package | Purpose | Status |
|---|---|---|
| [`@hashspan/core`](packages/core) | Transaction lifecycle tracker | [![npm](https://img.shields.io/npm/v/@hashspan/core?label=)](https://www.npmjs.com/package/@hashspan/core) |
| [`@hashspan/viem`](packages/viem) | Adapter for [viem](https://viem.sh) clients | [![npm](https://img.shields.io/npm/v/@hashspan/viem?label=)](https://www.npmjs.com/package/@hashspan/viem) |
| [`@hashspan/cdp`](packages/cdp) | Adapter for Coinbase CDP server and smart accounts | [![npm](https://img.shields.io/npm/v/@hashspan/cdp?label=)](https://www.npmjs.com/package/@hashspan/cdp) |
| [`@hashspan/x402`](packages/x402) | Adapter for x402 payments | [![npm](https://img.shields.io/npm/v/@hashspan/x402?label=)](https://www.npmjs.com/package/@hashspan/x402) |

Use one release line for every `@hashspan` package you install, such as 0.9.x of each: the adapters depend on the
`@hashspan/core` of their own minor (and `@hashspan/cdp` and `@hashspan/x402` on the `@hashspan/viem` of it), as
caret ranges do before 1.0. A tracker from another core release passed as the `tracker` option still works; what it
does not know is not recorded ([ADR 0014](docs/adr/0014-core-api-boundary.md)). The libraries each package
instruments are peer dependencies, with the supported ranges in its `package.json`; CI runs the CDP and x402 adapters
against the newest SDK releases in their ranges every week, and the x402 adapter also against the oldest.

## Quick start

Requires Node.js 22.3 or later. CI also loads the packed packages on Bun 1.x and Deno 2.x (`require()`,
`import` and a traced send, without a chain); other runtimes are not tested.

```sh
npm install @hashspan/viem @opentelemetry/api viem
npm install @opentelemetry/sdk-node   # unless your app already sets up an OpenTelemetry SDK
```

Start a local chain with `anvil` from [Foundry](https://getfoundry.sh) and a trace backend: the
[local lab](#local-lab) in a checkout of this repository, or the one-line [Jaeger container](docs/backends.md#jaeger).
Then save this file as `agent.ts`:

```ts
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

// Exports over OTLP to http://localhost:4318. Start it before the first transaction.
const sdk = new NodeSDK({ serviceName: 'my-agent' });
sdk.start();

// Anvil's public test mnemonic: its first account is funded on every Anvil chain.
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const transport = http('http://127.0.0.1:8545');

const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: foundry, transport }).extend(hashspan);
const reader = createPublicClient({ chain: foundry, transport }).extend(hashspan);

// Stands in for your agent's tool call: the send and confirm spans become its children.
await trace.getTracer('my-agent').startActiveSpan('pay_vendor', async (span) => {
  try {
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil's second account
    const hash = await wallet.sendTransaction({ to, value: parseEther('0.01') });
    await reader.waitForTransactionReceipt({ hash });
  } finally {
    span.end();
  }
});

// Before the process exits: hashspan's pending spans first, then the SDK.
await hashspan.flush();
await sdk.shutdown();
```

- **ES module:** the file uses top-level `await`, so set `"type": "module"` in `package.json`
  (`npm pkg set type=module`). The packages themselves load with both `import` and `require()`.
- **Run it** with `npx tsx agent.ts`, or with `node agent.ts` on Node.js 22.18 or later, which strips the types.
- **Start order:** hashspan gets its tracer and meter from `@opentelemetry/api` when the first transaction is sent,
  so `withHashspan()` and the clients may be created before or after `sdk.start()`, but the SDK must be started
  before the first transaction. Until an SDK is registered, nothing is recorded.
- **See it** in Jaeger on `http://localhost:16686`: service `my-agent`, trace `pay_vendor`, with the children
  `send 31337` and `confirm 31337` (the chain id), and the confirm span [linked](docs/backends.md#span-links) to the
  send span. [Backends](docs/backends.md) lists other setups.
- **Base Sepolia:** use `baseSepolia` from `viem/chains`, `http()` or your RPC URL, and a funded key from the
  environment, `privateKeyToAccount(process.env.PRIVATE_KEY)` from `viem/accounts`, instead.

`flush()` matters in any process that exits after its last transaction
([shutting down](packages/viem/README.md#shutting-down)). See [`@hashspan/viem`](packages/viem) for details and
[`@hashspan/core`](packages/core) to instrument other send paths.

## Try it

A runnable AI SDK agent that pays a vendor and hits a reverting vault, traced end to end. It needs no API key and
runs against a local chain:

```sh
nvm use && corepack enable pnpm && pnpm install
make lab-up   # Jaeger UI on http://localhost:16686
make demo
```

See [examples/ai-sdk-agent](examples/ai-sdk-agent).

## Local lab

Everything runs locally and can be removed with one command:

```sh
make lab-up      # Jaeger UI on http://localhost:16686, OTLP on :4317/:4318
make lab-metrics # also Prometheus and Grafana with the hashspan dashboard on http://localhost:3000
make anvil       # local EVM chain on :8545 (project-local binary)
make demo        # run the example agent against a fresh local chain
make lab-pause   # stop, keep state
make lab-nuke    # remove containers, images, tools and build output
```

## Documentation

- Website: [hashspan.dev](https://hashspan.dev)
- [Architecture](docs/architecture.md) · [Semantic conventions](docs/semconv.md) · [Tracing backends](docs/backends.md) · [Integrations](docs/integrations.md) · [Troubleshooting](docs/troubleshooting.md) · [Upstream findings](docs/upstream-findings.md) · [ADRs](docs/adr/) · [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Releasing](docs/releasing.md)

## Contributing

Questions, feedback on the span schema, bug reports and pull requests are all welcome. Start with the
[contributing guide](CONTRIBUTING.md), or pick a
[good first issue](https://github.com/selimaytac/hashspan/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## License

[Apache-2.0](LICENSE)
