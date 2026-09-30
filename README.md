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
| [`@hashspan/cdp`](packages/cdp) | Adapter for Coinbase CDP server accounts | in the next release |
| `@hashspan/x402` | Adapter for x402 payments | planned (v0.2) |

## Quick start

Requires Node.js 22.3 or later.

```sh
npm install @hashspan/viem @opentelemetry/api viem
```

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { withHashspan } from '@hashspan/viem';

const hashspan = withHashspan();
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() }).extend(hashspan);
const reader = createPublicClient({ chain: baseSepolia, transport: http() }).extend(hashspan);

// Inside an agent tool: send + confirm spans appear under the tool span.
const hash = await wallet.sendTransaction({ to, value });
await reader.waitForTransactionReceipt({ hash });
```

See [`@hashspan/viem`](packages/viem) for details and [`@hashspan/core`](packages/core) to instrument other send
paths.

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
make anvil       # local EVM chain on :8545 (project-local binary)
make demo        # run the example agent against a fresh local chain
make lab-pause   # stop, keep state
make lab-nuke    # remove containers, images, tools and build output
```

## Documentation

- [Architecture](docs/architecture.md) · [Semantic conventions](docs/semconv.md) · [ADRs](docs/adr/) · [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Releasing](docs/releasing.md)

## Contributing

Questions, feedback on the span schema, bug reports and pull requests are all welcome. Start with the
[contributing guide](CONTRIBUTING.md), or pick a
[good first issue](https://github.com/selimaytac/hashspan/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## License

[Apache-2.0](LICENSE)
