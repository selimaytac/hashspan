# Contributing

Thanks for your interest! Issues, questions and pull requests are all welcome.

## Getting started

```sh
nvm use                 # Node version from .nvmrc
corepack enable pnpm
pnpm install
make tools              # project-local Anvil for integration tests
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
```

Conventions (commit style, tests, API stability) are described in [AGENTS.md](AGENTS.md); they apply to humans and
AI coding agents alike.

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Keep the PR focused on one concern and include tests.
3. Add a changeset (`pnpm changeset`) for user-visible changes.
4. Changes to span or attribute names need an update to `docs/semconv.md` and, if significant, an ADR.

Look for issues labelled `good first issue` to get started.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
