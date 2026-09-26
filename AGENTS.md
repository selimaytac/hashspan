# AGENTS.md

Instructions for AI coding agents and humans contributing to hashspan.

## Project
OpenTelemetry tracing for on-chain transactions sent by AI agents: every transaction an agent triggers becomes a
`send` / `confirm` span pair under the agent's own trace, exported to any OTLP backend.

## Setup & commands
- Node version: see `.nvmrc` (`nvm use`); package manager: pnpm via corepack (`corepack enable pnpm`)
- Install deps: `pnpm install`
- Build: `pnpm build`
- Test (unit / integration): `pnpm test` / `pnpm test:integration` (needs Anvil: `make tools`)
- Lint & format: `pnpm lint` / `pnpm format`
- Typecheck: `pnpm typecheck`
- Local lab: `make lab-up` (Jaeger), `make anvil` (local chain), `make lab-pause`, `make lab-nuke`
Run lint, typecheck and tests before proposing a change.

## Architecture
- `packages/core` → transaction lifecycle tracker (spans, links, fees, privacy modes)
  - `src/tracker.ts` public `createTxTracker()`; `src/attributes.ts` attribute keys (mirror of docs/semconv.md);
    `src/privacy.ts` address modes; `src/link-store.ts` send→confirm links; `src/agent.ts` agent identity
  - `test/helpers.ts` registers an in-memory tracer provider for span assertions
- `packages/viem` → capture adapter for viem clients
- `examples/` → runnable agent integrations
- `docker/`, `scripts/`, `Makefile` → local lab
See [docs/architecture.md](docs/architecture.md), [docs/semconv.md](docs/semconv.md) and [docs/adr/](docs/adr/).

## Conventions
- Language: all code, comments, docs, commits and PRs in English.
- Commits: Conventional Commits `<type>(<scope>): <description>`, subject ≤ 72 chars. Scopes: `core`, `viem`,
  `examples`, `docs`, `ci`, `lab`.
- Small, focused PRs; one concern per PR; update tests and docs with the change.
- Tests first: every behaviour change comes with a unit test; anything touching RPC or receipts also gets an Anvil
  integration test. Tests never depend on a public network.
- Public API, span names and attribute names (docs/semconv.md) are stable contracts: deprecate before removing;
  add a changeset (`pnpm changeset`) and note it in CHANGELOG.md.
- Instrumentation must never throw into or alter the result of the user's call; failures are swallowed and logged
  via `diag`.
- Only `@opentelemetry/api` (and the instrumented library) may be peer dependencies of published packages.
- `src/` must not use Node.js-only APIs at import time (it is type-checked without Node types via `tsconfig.json`;
  tests use `tsconfig.test.json`). Exported functions need explicit return types (`isolatedDeclarations`).
- Package versions live in `package.json`; `src/version.ts` is synced by `pnpm version-packages`; don't edit it.
- Significant design changes get a short ADR in `docs/adr/NNNN-title.md` (see `0000-template.md`).
- Prefer OSI-licensed dependencies; flag non-OSS licenses.

## Security
- Never commit secrets or private keys (use Anvil's well-known test accounts in tests); gitleaks runs in CI.
- Report vulnerabilities per SECURITY.md, not in public issues.

## Boundaries
- Don't modify generated files (`dist/`, `CHANGELOG.md`), vendored code or release tooling without being asked.
- Don't add new dependencies without justification in the PR description.
