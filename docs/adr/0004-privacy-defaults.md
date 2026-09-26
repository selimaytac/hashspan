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
- Decoded calldata arguments: **off** by default; opt-in per instrumentation.
- Function name and 4-byte selector: on by default (derived from public contract interfaces).
- A user-supplied redaction hook runs last and can drop or rewrite any attribute.

## Consequences

- Defaults favour debuggability while keeping the most sensitive payload opt-in.
- The README documents what is recorded by default, so operators can make an informed decision.
