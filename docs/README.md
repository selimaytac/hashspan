# Documentation

The website, [hashspan.dev](https://hashspan.dev), has the guides; this folder has the reference of the repository.

## Start

- [Quick start](quick-start.md): a runnable setup, one traced transaction on a local chain
- [Tracing backends](backends.md): Jaeger, Grafana Tempo, Langfuse and others, or the console
- [Integrations](integrations.md): agent frameworks, wallet services, smart account SDKs and services that are not
  agents
- [Troubleshooting](troubleshooting.md): missing spans and other surprises

## Reference

- [Semantic conventions](semconv.md): span, attribute and metric names, and their change policy
- [Architecture](architecture.md): the packages, the principles and the requests hashspan adds
- [@hashspan/viem reference](viem.md): how each feature of the viem adapter behaves at its edges
- Package READMEs: [core](../packages/core), [viem](../packages/viem), [cdp](../packages/cdp),
  [x402](../packages/x402), [mpp](../packages/mpp)

## Project

- [Roadmap](roadmap.md)
- [Releasing](releasing.md), with [versions](releasing.md#versions) and how the packages are released
- [Architecture decision records](adr/)
- [Upstream findings](upstream-findings.md): bugs found in dependencies and what hashspan does about them
- [x402 facilitator conformance matrix](facilitators.md): the same payments sent to several facilitators on a local
  chain, compared with the spec and with each other
- [Dev-node matrix](nodes.md): the same transactions and JSON-RPC calls sent to Anvil, Hardhat, Reth and Geth, compared
  with the execution-apis spec and with each other
- [Migrating to 1.0](migrating-to-1.0.md)
