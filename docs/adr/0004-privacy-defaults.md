# 0004. Privacy defaults

- Status: accepted
- Date: 2026-09-26

## Context

Traces often leave the application boundary (hosted backends, shared dashboards). Wallet addresses are
pseudonymous identifiers and may be personal data under GDPR. Decoded calldata arguments can contain amounts,
counterparties and free text; OpenTelemetry GenAI conventions treat the analogous `gen_ai.tool.call.arguments` as
opt-in for the same reason. Hashing an address does not make it anonymous, so it offers limited compliance benefit
while removing the ability to look the address up in a block explorer.

## Decision

- Addresses (`blockchain.tx.from`, `blockchain.tx.to`): mode `raw` (default) | `hashed` | `off`.
- Decoded calldata arguments: **off** by default; opt-in per instrumentation. Recording them has no side effects for ordinary values (the traps of a Proxy still run):
  only own enumerable data properties are read, never `toJSON()` or getters, so the value and the calldata a
  library encodes from it stay unchanged.
- In `hashed` and `off` mode, hex values longer than an address (a padded `bytes32`, ABI-encoded `bytes`) are
  recorded as `<hex>` wherever addresses are formatted (call arguments, revert reasons, error types, sanitized
  error messages), because they can embed an address. `raw` mode records them unchanged. Unprefixed hex and
  addresses written as numbers are not detected; the redaction hook covers such cases.
- Function name and 4-byte selector: on by default (derived from public contract interfaces).
- A user-supplied redaction hook runs last and can drop or rewrite any attribute.
- Error messages and stack traces: off by default; see [ADR 0006](0006-error-privacy.md).

## Consequences

- Defaults favour debuggability while keeping the most sensitive payload opt-in.
- The README documents what is recorded by default, so operators can make an informed decision.
- Amended for payments (ADR 0013): the resource an agent paid for is recorded as its URL's origin by default, since
  paths often carry user or account identifiers; its path is opt-in (`paymentResource: 'path'`), and its query
  string, fragment and user info are never recorded.
