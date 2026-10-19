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
- Package READMEs: [core](../packages/core), [viem](../packages/viem), [cdp](../packages/cdp),
  [x402](../packages/x402), [mpp](../packages/mpp)

## Project

- [Roadmap](roadmap.md)
- [Releasing](releasing.md), with [versions](releasing.md#versions) and how the packages are released
- [Architecture decision records](adr/)
- [Upstream findings](upstream-findings.md): bugs found in dependencies and what hashspan does about them
- [Migrating to 1.0](migrating-to-1.0.md)
