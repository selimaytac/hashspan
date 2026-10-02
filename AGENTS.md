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
- Third-party integration tests: `pnpm --dir integrations install`, then `pnpm test:integrations` (typecheck and
  tests, needs Anvil)
- Lint & format: `pnpm lint` / `pnpm format`
- Typecheck: `pnpm typecheck` (builds the packages first, since adapters type-check against `@hashspan/core` output)
- Coverage: `pnpm test:coverage` (unit and integration, with thresholds in `vitest.config.ts`; runs in CI)
- Package checks: `pnpm check:packages` (publint and arethetypeswrong on the built packages; runs in CI)
- Smoke test: `pnpm smoke:packages` (packs the four packages, installs the tarballs with their peer dependencies into an
  empty project and checks `require()`, `import` and `hashed` address mode on the current Node.js; CI runs it on the
  lowest `engines.node`, the latest 22.x and the latest 24.x; needs the npm registry, no chain)
- Local lab: `make lab-up` (Jaeger), `make anvil` (local chain), `make demo` (example agent), `make lab-pause`,
  `make lab-nuke`
Run lint, typecheck and tests before proposing a change.

### Fast paths while iterating
- One test file: `pnpm vitest run packages/viem/test/transport.test.ts` (an `.int.test.ts` file needs Anvil)
- One package's unit tests: `pnpm vitest run --project unit packages/core`
- Tests by name: `pnpm vitest run packages/core -t "metrics"`
- One package's types: `pnpm --filter @hashspan/x402 typecheck`, after one `pnpm build` (adapters read the built core)
- Under a coding agent vitest prints a short summary on its own; set `AI_AGENT=<name>` if it does not detect yours.

## Architecture
Each package, example and `integrations/` has its own `AGENTS.md` with its files, test setup and rules: read it
before changing there.
- `packages/core` → transaction lifecycle tracker: send, confirm, payment and user operation spans, links, fees,
  privacy modes, metrics ([AGENTS.md](packages/core/AGENTS.md))
- `packages/viem` → capture adapter for viem clients ([AGENTS.md](packages/viem/AGENTS.md))
- `packages/cdp` → capture adapter for the Coinbase CDP SDK ([AGENTS.md](packages/cdp/AGENTS.md))
- `packages/x402` → adapter for x402 payments ([AGENTS.md](packages/x402/AGENTS.md))
- `examples/` → runnable agent integrations ([ai-sdk-agent](examples/ai-sdk-agent/AGENTS.md))
- `integrations/` → private tests of the setups in docs/integrations.md with the third-party libraries they name, a
  workspace of its own ([AGENTS.md](integrations/AGENTS.md))
- `docker/`, `scripts/`, `Makefile` → local lab and release tooling; `scripts/demo.sh` (behind `make demo`) starts a
  fresh Anvil or fails, and `scripts/publish-in-order.mjs` (behind `pnpm release`) publishes one dependency layer at
  a time (see docs/releasing.md)
See [docs/architecture.md](docs/architecture.md), [docs/semconv.md](docs/semconv.md) and the ADR index,
[docs/adr/README.md](docs/adr/README.md), with each decision in one line.

## Conventions
- Language: all code, comments, docs, commits and PRs in English.
- Commits: Conventional Commits `<type>(<scope>): <description>`, subject ≤ 72 chars. Scopes: `core`, `viem`, `cdp`,
  `x402`, `examples`, `docs`, `ci`, `lab`.
- Small, focused PRs; one concern per PR; update tests and docs with the change.
- Pick open issues by their priority label, `priority: P0` first: a P0 comes before work in progress
  ([CONTRIBUTING.md](CONTRIBUTING.md#priority-labels)). Link the issue in the PR (`Closes #123`).
- Tests first: every behaviour change comes with a unit test; anything touching RPC or receipts also gets an Anvil
  integration test. Tests never depend on a public network.
- Public API, span names and attribute names (docs/semconv.md) are stable contracts: deprecate before removing;
  add a changeset (`pnpm changeset`), from which the generated CHANGELOG.md is written.
- Changesets describe released behaviour: a follow-up change to a feature that has not been published yet updates
  that feature's changeset instead of adding a new one.
- `TxTracker` and its handles are produced by `createTxTracker()` only; adding members to them is a minor change.
  Adapters detect members newer than the oldest core they accept (ADR 0014).
- Instrumentation must never throw into or alter the result of the user's call; failures are swallowed and logged
  via `diag`. Adapters read call arguments only from own data properties, so no getter of the user's runs.
- Only `@opentelemetry/api` and the instrumented library may be peer dependencies of published packages; an adapter
  may also peer-depend on a library its API takes values from (`@hashspan/cdp` on `viem`, for the `reader`).
- `src/` must not use Node.js-only APIs at import time (it is type-checked without Node types via `tsconfig.json`;
  tests use `tsconfig.test.json`). Exported functions need explicit return types (`isolatedDeclarations`).
- Package versions live in `package.json`; `src/version.ts` is synced by `pnpm version-packages`; don't edit it.
- Docs are checked by `packages/core/test/docs.test.ts` (links and anchors, ADR index, package table, scopes, Node
  versions, code examples) and `semconv-doc.test.ts`. Each `ts` block in a markdown file is the `#region readme` of a
  file in `packages/*/test/readme/`, compiled by `pnpm typecheck`; change both together. State each fact in one place
  and link to it. Package READMEs and `/** */` comments ship to npm alone: link to the docs by absolute URL on the
  package's release tag (see docs/releasing.md); `//` comments may use repository paths.
- Each `AGENTS.md` has a `CLAUDE.md` next to it that only imports it (`@AGENTS.md`), for tools that read `CLAUDE.md`.
- Significant design changes get a short ADR in `docs/adr/NNNN-title.md` (see `0000-template.md`) and a row in
  `docs/adr/README.md`. New ADRs start as `proposed` and move to `accepted` only after the implementation was
  compared with them.
- Prefer OSI-licensed dependencies; flag non-OSS licenses.

## Security
- Never commit secrets or private keys (use Anvil's well-known test accounts in tests); gitleaks runs in CI.
- Report vulnerabilities per SECURITY.md, not in public issues.

## Boundaries
- Don't modify generated files (`dist/`, `CHANGELOG.md`), vendored code or release tooling without being asked.
- Don't add new dependencies without justification in the PR description.
