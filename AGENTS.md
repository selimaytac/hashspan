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
  - Tests import workspace packages from source (`vitest.config.ts` alias), so no build is needed first
- Lint & format: `pnpm lint` / `pnpm format`
- Typecheck: `pnpm typecheck` (builds the packages first, since adapters type-check against `@hashspan/core` output)
- Local lab: `make lab-up` (Jaeger), `make anvil` (local chain), `make demo` (example agent), `make lab-pause`,
  `make lab-nuke`
Run lint, typecheck and tests before proposing a change.

## Architecture
- `packages/core` → transaction lifecycle tracker (spans, links, fees, privacy modes)
  - `src/tracker.ts` public `createTxTracker()`; `src/attributes.ts` attribute keys (mirror of docs/semconv.md);
    `src/privacy.ts` address modes; `src/link-store.ts` send→confirm links;
    `src/confirm-registry.ts` one confirm span per transaction; `src/agent.ts` agent identity
  - `test/helpers.ts` registers an in-memory tracer provider for span assertions
- `packages/viem` → capture adapter for viem clients
  - `src/index.ts` `withHashspan()`: a `client.extend()` extension wrapping `sendTransaction`, `writeContract` and
    `waitForTransactionReceipt`; it calls the base client's actions, so internal viem calls are not traced twice.
    State shared by every client extended with one `withHashspan()` result (tracker, ABIs, revert reasons) lives in
    that call's closure; confirm deduplication lives in the tracker (ADR 0007); background confirmation must
    never delay or fail the user's call, and no telemetry work runs before the call it traces (ADR 0009).
    Work that outlives a traced call must be passed to `track()`, so `flush()` can await it (ADR 0010)
  - `src/revert-reason.ts` replays reverted transactions and decodes the revert data (ADR 0005)
  - `test/mock-transport.ts` EIP-1193 mock for unit tests; `test/*.int.test.ts` run against Anvil via prool
- `examples/` → runnable agent integrations
  - `ai-sdk-agent`: AI SDK agent with a scripted model (no API key), run by `make demo`; its
    `test/*.int.test.ts` runs the agent against Anvil in CI, so the example cannot silently break
- `docker/`, `scripts/`, `Makefile` → local lab; `scripts/demo.sh` (behind `make demo`) starts a fresh Anvil or
  fails, and is tested from `examples/ai-sdk-agent/test/demo-script.test.ts`
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
- Changesets describe released behaviour: a follow-up change to a feature that has not been published yet updates
  that feature's changeset instead of adding a new one.
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
