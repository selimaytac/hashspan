# 0027. What 1.0 freezes

- Status: proposed
- Date: 2026-10-04

## Context

1.0 is the first release that promises Semantic Versioning to its users: after it, a breaking change needs a major
release. The roadmap asks for a stated policy on what that promise covers (the public API) and what stays
`development` (the semantic conventions, under their change policy).

Three things make the line less obvious than "the exports":

- **The packages ship two contracts.** The TypeScript API is what code compiles against. The span names, attribute
  names and values in [docs/semconv.md](../semconv.md) are what dashboards, alerts and queries depend on, and they
  are marked `development`.
- **The exported attribute constants (`ATTR_*` and `*_VALUE_*`) belong to both.** Freezing them as exports would
  also freeze the names they hold, while the conventions are meant to keep moving.
- **The change policy in docs/semconv.md covers attributes only.** It says nothing about metric names, span names,
  enum values, or a change to what an existing attribute means. A review of every name before 1.0 found this gap:
  folding the OP Stack operator fee into `blockchain.tx.fee` (#287) would change what an existing value means.

Since #362 the API Extractor report of each package (`packages/*/etc/*.api.md`) lists every exported declaration,
and CI fails when it is stale.

## Decision

**Frozen at 1.0 (a breaking change needs a major release):**

- The declarations in the API reports of the four packages, with their names, parameters and types: functions,
  options objects (`WithHashspanOptions` and the others), result and input types, and the structural types a
  parameter uses, such as `CdpClientLike`. A report is the authoritative list; a declaration that is not in a report
  is not public.
- The behaviour the API promises in its doc comments and READMEs: instrumentation never throws into or changes the
  result of the caller's call (ADR 0025), `flush()` resolves to a boolean, and the defaults keep their meaning.
- `TxTracker` and its handles stay produced by `createTxTracker()` only: adding members to them, and to their
  handles, is a minor change (ADR 0014).
- Supported environments: raising the lowest supported Node.js version (`engines.node`) or the lowest version of a
  peer dependency's range is a major change, with two exceptions, each a minor or patch change with a changeset:
  dropping a Node.js release line past its end of life, and raising a floor to leave out versions with a published
  security advisory (the changeset links it). Users already on a newer version see no change either way.

**Not part of the public API:** `diag` messages, file and module layout inside a package, chunk names in `dist/`,
anything not exported from a package's entry point, and the test helpers.

**Stays `development` after 1.0:** the semantic conventions (span names, attribute names and their values, metric
names and their attributes), with the change policy of docs/semconv.md, extended to cover every kind of name:

- Additions are minor changes: a new attribute, a new metric, a new enum value. Consumers handle values they do not
  know, as `_OTHER` already asks.
- A rename or removal of an attribute, a metric or an enum value records the old and the new name side by side for
  at least one minor release, is announced in the CHANGELOG, and bumps the schema version. A span name, which cannot
  be recorded twice, changes only in a minor release, announced the same way.
- The meaning of an existing name is not changed in place: a new meaning gets a new name, and the old one is
  deprecated through the steps above.
- Value forms are part of each attribute: the type and form the docs/semconv.md table states (lower-case `0x`
  addresses, decimal amounts, `0x` hashes, integer chain ids, bounded lengths, #338) change only through the same
  steps.

**The exported constants follow the conventions, not the API freeze:** a deprecated constant stays exported, marked
`@deprecated` with its replacement, until the next major release, and the value it holds is recorded as long as the
change policy says.

**Removed at 1.0, as announced:** the positional forms of the handle methods (ADR 0014),
`BLOCKCHAIN_TX_STATUS_VALUE_TIMEOUT` (ADR 0016) and `ATTR_BLOCKCHAIN_SYSTEM`, replaced by
`ATTR_BLOCKCHAIN_SYSTEM_NAME` and recorded side by side in the 0.x minor before 1.0.

## Consequences

- A pull request that changes a frozen declaration shows it in its API report diff, so review sees every API change.
  A change there after 1.0 needs a major changeset; the report diff and the changeset are checked together.
- The change policy in docs/semconv.md is rewritten to the four rules above, in one place, and the roadmap's freeze
  criterion links to this ADR.
- #287 records the operator fee as `blockchain.tx.operator_fee` rather than changing `blockchain.tx.fee`.
- Raising the viem floor (`^2.21.0`) or the CDP SDK floor after 1.0 waits for a major release, unless a security
  advisory covers the versions left out; the weekly jobs that test both ends of each peer range (#299, #321) keep the
  floors honest until then.
- API Extractor reads the declarations with its own TypeScript 5.9 while the packages build with TypeScript 7. The
  reports stay valid while the emitted declarations use syntax both accept; a declaration only TypeScript 7 can read
  shows up as a failing `pnpm api:check`, and is solved then.
