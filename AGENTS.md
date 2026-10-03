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

## Architecture
- `packages/core` → transaction lifecycle tracker (spans, links, fees, privacy modes)
  - `src/tracker.ts` public `createTxTracker()`; `src/attributes.ts` attribute keys (mirror of docs/semconv.md);
    `src/privacy.ts` address modes; `src/link-store.ts` send→confirm links;
    `src/confirm-registry.ts` one confirm span per transaction; `src/agent.ts` agent identity
  - `test/helpers.ts` registers an in-memory tracer provider for span assertions
- `packages/viem` → capture adapter for viem clients
  - `src/index.ts` `withHashspan()`: a `client.extend()` extension wrapping `sendTransaction`, `writeContract` and
    `waitForTransactionReceipt`, and a bundler client's `sendUserOperation` and `waitForUserOperationReceipt`
    (ADR 0021); it calls the base client's actions, so internal viem calls are not traced twice.
    State shared by every client extended with one `withHashspan()` result (tracker, ABIs, revert reasons) lives in
    that call's closure; confirm deduplication lives in the tracker (ADR 0007); background confirmation must
    never delay or fail the user's call, and nothing the telemetry needs is awaited before the call it traces
    (ADR 0009). Work that outlives a traced call must be passed to `track()`, so `flush()` can await it (ADR 0010)
  - `src/revert-reason.ts` replays reverted transactions and decodes the revert data (ADR 0005)
  - `test/mock-transport.ts` EIP-1193 mock for unit tests (`test/mock-bundler.ts` for bundler clients);
    `test/*.int.test.ts` run against Anvil via prool; user operations go through `test/test-bundler.ts`, an
    in-process bundler, to a stand-in EntryPoint (`test/entry-point/`, compiled into `test-entry-point.ts`)
- `packages/cdp` → capture adapter for the Coinbase CDP SDK (ADR 0012)
  - `src/index.ts` `withHashspan(cdp, { reader })` wraps `cdp.evm` and the accounts its factories return, in place;
    confirmations go through `@hashspan/viem`'s `watch()`; `src/networks.ts` maps CDP network names to chain ids;
    `src/user-operation.ts` user operations of smart accounts (ADR 0021), completed from the bundle receipt's
    `UserOperationEvent` with a reader; `src/own.ts` reads arguments without running getters
  - `test/mock-cdp-api.ts` local stand-in for the CDP API that broadcasts on Anvil; tests never leave localhost
  - `test/sdk-drift.test.ts` compares the adapter's copies of SDK rules with the installed SDK;
    `.github/workflows/cdp-sdk-latest.yml` runs the cdp tests weekly against the newest SDK in the peer range
- `packages/x402` → adapter for x402 payments (ADR 0013)
  - `src/index.ts` `withHashspan(client, { reader })` registers hooks on an `x402Client`: each payment becomes a
    `payment` span (no send span: the facilitator sends); confirmations go through `@hashspan/viem`'s `watch()`.
    Hooks never throw or return a value; payments without a response end as `timeout`, bounded in time and number
  - `test/fake-x402.ts` a real `x402Client` with a signing-free scheme and a fake paid API, offline; the identities
    of SDK objects across hooks, which the adapter relies on, are asserted in `test/adapter.test.ts`
  - `test/settlement.int.test.ts` settles real EIP-3009 payments on Anvil through the SDK's resource server and
    facilitator, with `test/token/TestUsd.sol` (compiled into `test-usd.ts` by `test/token/compile.mjs`);
    `.github/workflows/x402-sdk.yml` runs the x402 tests weekly against both ends of the SDK peer range
  - `test/permit2-settlement.int.test.ts` settles real Permit2 `exact` and `upto` payments with the same token, with
    Permit2 and the x402 proxies installed from `test/permit2/contracts.ts` (copied from Base Sepolia by
    `test/permit2/fetch.mjs`, never run in tests)
- `examples/` → runnable agent integrations
  - `ai-sdk-agent`: AI SDK agent with a scripted model (no API key), run by `make demo`; its
    `test/*.int.test.ts` runs the agent against Anvil in CI, so the example cannot silently break;
    `src/base-sepolia.ts` (behind `make demo-base-sepolia`) runs it on the testnet with a key from the environment,
    tested against an Anvil that reports chain id 84532
- `integrations/` → private tests that run the setups of docs/integrations.md with the third-party libraries they
  name, against Anvil
  - a workspace of its own with its own lockfile, so those libraries stay out of the main install and of the
    dependency audit and license check; it imports hashspan from source (`integrations/vitest.config.ts` alias), so
    the main install comes first
  - `test/offline.ts` a setup file that lets only loopback requests through `fetch` and answers AgentKit's analytics
    requests; `test/agentkit-viem.int.test.ts` the AgentKit `ViemWalletProvider` setup;
    `test/goat-viem.int.test.ts` the GOAT `viem()` wallet setup;
    `test/mastra.int.test.ts` the Mastra OpenTelemetry bridge setup, with a scripted model
  - `.github/workflows/integrations.yml` runs them on pull requests that touch `packages/` or `integrations/`, and
    weekly with every dependency of `integrations/` updated to the newest release within its range
- `docker/`, `scripts/`, `Makefile` → local lab; `scripts/demo.sh` (behind `make demo`) starts a fresh Anvil or
  fails, waiting for Anvil's own "Listening on" line rather than probing the port, and is tested from
  `examples/ai-sdk-agent/test/demo-script.test.ts`; `scripts/publish-in-order.mjs` (behind `pnpm release`) publishes
  one dependency layer at a time and waits for the registry between layers (see docs/releasing.md)
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
  add a changeset (`pnpm changeset`) and note it in CHANGELOG.md.
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
  versions, code examples) and `semconv-doc.test.ts`. Each `ts` block in a README is the `#region readme` of a file
  in `packages/*/test/readme/`, compiled by `pnpm typecheck`; change both together. State each fact in one place
  and link to it. Package READMEs and `/** */` comments ship to npm alone: link to the docs by absolute URL on the
  package's release tag (see docs/releasing.md); `//` comments may use repository paths.
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
