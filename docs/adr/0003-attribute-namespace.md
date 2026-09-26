# 0003. `blockchain.*` attribute namespace, development stability, versioned schema

- Status: accepted
- Date: 2026-09-26

## Context

OpenTelemetry has no semantic conventions for blockchains, and no open proposal (checked 2026-09). Span and
attribute names are the public API of a telemetry library: renaming them breaks users' dashboards and queries.

## Decision

- Use `blockchain.*` with `blockchain.system` (`evm` today), following the `db.*` / `rpc.*` pattern of existing
  conventions so that non-EVM chains fit later.
- Reuse existing conventions where they apply: `rpc.*` / `jsonrpc.*` for RPC spans, `gen_ai.agent.*` for agent
  identity, `error.type` for errors.
- Mark every attribute `development` and document it in [`docs/semconv.md`](../semconv.md), versioned alongside the
  packages. Changes follow the deprecation policy in AGENTS.md.
- Once the schema has real users, propose it upstream to OpenTelemetry semantic conventions.

## Consequences

- A single documented schema doubles as the draft for an upstream proposal.
- Monetary values (wei) exceed int64 and are emitted as decimal strings.
