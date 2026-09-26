# hashspan

**Trace your AI agents' on-chain transactions with OpenTelemetry.**

hashspan turns every transaction an agent sends into spans, keyed by the transaction hash, inside the agent's
own OpenTelemetry trace.

[![CI](https://github.com/selimaytac/hashspan/actions/workflows/ci.yml/badge.svg)](https://github.com/selimaytac/hashspan/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **Status: pre-release.** The design is settled ([ADRs](docs/adr/)); the implementation is in progress; see the
> [roadmap](docs/roadmap.md). Feedback on the [attribute schema](docs/semconv.md) is very welcome.

When an AI agent sends a transaction, the agent trace usually stops at the tool call. Whether the transaction was
mined, reverted, or what it cost lives somewhere else. hashspan closes that gap: each transaction becomes a
`send` / `confirm` span pair **inside the agent's own trace**, with status, gas, L2 fees and the agent identity
attached, and it's exported to the backend you already use (Jaeger, Grafana Tempo, Langfuse, Honeycomb, ...).

```
invoke_agent treasury-bot
└─ execute_tool transfer_usdc
   ├─ send 8453        blockchain.tx.hash=0x9f…  blockchain.contract.function.name=transfer
   └─ confirm 8453     blockchain.tx.status=success  blockchain.tx.fee=41730000000000  ↪ link: send
```

## Why

- **No new dashboard.** It's a library that emits standard OpenTelemetry spans. Your existing backend is the UI.
- **Agent-aware.** Transaction spans nest under your framework's agent/tool spans and carry `gen_ai.agent.id`.
- **Real cost.** Fees include the L1 data fee on OP-stack chains such as Base.
- **Small footprint.** The only peer dependency is `@opentelemetry/api`. It never signs or broadcasts transactions.
- **Privacy by design.** Calldata arguments are opt-in, and addresses can be hashed or dropped ([ADR 0004](docs/adr/0004-privacy-defaults.md)).

## Packages

| Package | Purpose | Status |
|---|---|---|
| `@hashspan/core` | Transaction lifecycle tracker | in progress |
| `@hashspan/viem` | Adapter for [viem](https://viem.sh) clients | in progress |
| `@hashspan/cdp` | Adapter for Coinbase CDP wallets | planned (v0.2) |
| `@hashspan/x402` | Adapter for x402 payments | planned (v0.2) |

## Quick start

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

## Local lab

Everything runs locally and can be removed with one command:

```sh
make lab-up      # Jaeger UI on http://localhost:16686, OTLP on :4317/:4318
make anvil       # local EVM chain on :8545 (project-local binary)
make lab-pause   # stop, keep state
make lab-nuke    # remove containers, images, tools and build output
```

## Documentation

- [Architecture](docs/architecture.md) · [Semantic conventions](docs/semconv.md) · [ADRs](docs/adr/) · [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[Apache-2.0](LICENSE)
