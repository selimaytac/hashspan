# 0003. `blockchain.*` attribute namespace, development stability, versioned schema

- Status: accepted
- Date: 2026-09-26
- Amended: 2026-10-04: the change policy is the one in docs/semconv.md, not AGENTS.md.

## Context

OpenTelemetry has no semantic conventions for blockchains, and no open proposal (checked 2026-09). Span and
attribute names are the public API of a telemetry library: renaming them breaks users' dashboards and queries.

## Decision

- Use `blockchain.*` with `blockchain.system` (`evm` today), following the `db.*` / `rpc.*` pattern of existing
  conventions so that non-EVM chains fit later.
- Reuse existing conventions where they apply: `rpc.*` / `jsonrpc.*` for RPC spans, `gen_ai.agent.*` for agent
  identity, `error.type` for errors.
- Mark every attribute `development` and document it in [`docs/semconv.md`](../semconv.md), versioned alongside the
  packages. Changes follow its [change policy](../semconv.md#change-policy).
- Once the schema has real users, propose it upstream to OpenTelemetry semantic conventions.

## Consequences

- A single documented schema doubles as the draft for an upstream proposal.
- Monetary values (wei) exceed int64 and are emitted as decimal strings.

## Amendment (2026-10-04): `blockchain.system.name`

`blockchain.system` is renamed to `blockchain.system.name`, as OpenTelemetry renamed `db.system` and `rpc.system` to
`db.system.name` and `rpc.system.name`. Following the change policy in [docs/semconv.md](../semconv.md#change-policy),
both are recorded with the same value until 1.0, which removes `blockchain.system`; the schema version is
`0.3.0-dev`.
