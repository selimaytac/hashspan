# Contributing

Thanks for your interest in hashspan! Bug reports, questions, feedback on the
[semantic conventions](docs/semconv.md), docs and code are all welcome. You don't need to write code to help:
telling us how the spans look in your backend, or where the docs lost you, is just as useful.

## Ways to contribute

- **Ask a question or share feedback**: start a [discussion](https://github.com/selimaytac/hashspan/discussions).
  Feedback on span and attribute names is especially valuable while they are marked `development`.
- **Report a bug**: first [search the issues](https://github.com/selimaytac/hashspan/issues?q=is%3Aissue), open and
  closed, then use the [bug report](https://github.com/selimaytac/hashspan/issues/new?template=bug_report.yml)
  template with a minimal reproduction.
- **Pick up an issue**: [`good first issue`](https://github.com/selimaytac/hashspan/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  issues are scoped and list what "done" means. Larger items from the [roadmap](docs/roadmap.md) are welcome too;
  open an issue first to agree on the design.
- **Propose a feature**: search the issues too, then open a [feature request](https://github.com/selimaytac/hashspan/issues/new?template=feature_request.yml)
  describing the problem you want to solve.
- **Report a vulnerability**: privately, as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Working on an issue

1. Comment on the issue to say you'd like to work on it, and it will be assigned to you. This avoids two people
   doing the same work.
2. For anything larger than a small fix, describe your approach in the issue before writing much code, so we can
   agree on it early.
3. If you can't continue, just say so in the issue; no problem at all. An assigned issue without activity for two
   weeks may be offered to someone else.
4. Draft pull requests are welcome if you want early feedback.

## Priority labels

Bugs and other work are triaged with a priority label, which sets the order they are handled in:

| Label | Meaning | Handled |
|---|---|---|
| `priority: P0` | Breaks a released user's call or leaks data | First, before any other work, including work in progress |
| `priority: P1` | Correctness issue | In the next round of fixes |
| `priority: P2` | Important | Together, at the end of a milestone |
| `priority: P3` | Nice to have | When there is time; may be deferred |

An issue without a priority label has not been triaged yet. Security issues never get a public issue; see
[SECURITY.md](SECURITY.md).

## Development setup

**Requirements**

- macOS or Linux (on Windows, use [WSL](https://learn.microsoft.com/windows/wsl/install)); the integration tests
  download a pinned Anvil binary for these platforms.
- Node.js from [`.nvmrc`](.nvmrc) (development needs Node.js 22.18 or later; the published packages themselves
  support Node.js 22.3 or later). With [nvm](https://github.com/nvm-sh/nvm): `nvm use`.
- pnpm through corepack, which ships with Node.js.
- Docker, only for the optional local lab (Jaeger).

**First run**

```sh
nvm use                 # Node version from .nvmrc
corepack enable pnpm
pnpm install
make tools              # project-local Anvil in ./.tools for integration tests
pnpm test               # unit tests
pnpm test:integration   # integration tests against Anvil
```

Tests import the packages from source, so no build is needed first. To see traces in a UI, run `make lab-up`
(Jaeger on http://localhost:16686) and `make demo`; `make lab-nuke` removes everything again.

## Before you open a pull request

CI runs these checks; running them locally saves a round trip:

```sh
pnpm lint               # Biome; `pnpm format` fixes most findings
pnpm typecheck
pnpm test:coverage      # unit + integration tests, with coverage thresholds
pnpm check:packages     # publint and arethetypeswrong on the built packages
```

`pnpm test:coverage` fails if coverage drops below the thresholds in [`vitest.config.ts`](vitest.config.ts), so new
code needs tests. Behaviour changes need a unit test, and anything touching RPC calls or receipts also needs an
Anvil integration test (`*.int.test.ts`). Tests never use a public network.

Tests of the setups in [docs/integrations.md](docs/integrations.md) live in `integrations/`, a workspace of its own: run `pnpm --dir integrations install` once, then `pnpm test:integrations`. CI runs these tests on pull requests
that touch `packages/` or `integrations/`.

## Pull request guidelines

- **One concern per PR**, linked to its issue (`Closes #123`).
- **Title in [Conventional Commits](https://www.conventionalcommits.org/) form**, for example
  `feat(viem): trace sendRawTransaction`. PRs are squash-merged, so the title becomes the commit message. Scopes:
  `core`, `viem`, `cdp`, `x402`, `examples`, `docs`, `ci`, `lab`; keep it under 72 characters.
- **Changeset for user-visible changes**: run `pnpm changeset`, pick the packages and the bump type, and commit the
  generated file. Docs, test and CI changes don't need one.
- **Span and attribute names are a public contract**: changing them needs an update to
  [`docs/semconv.md`](docs/semconv.md) and, if significant, an [ADR](docs/adr/).
- **New dependencies** need a short justification in the PR description. CI fails on high or critical
  advisories (`pnpm audit --audit-level high`) and on licenses or SPDX exceptions outside the allowlists in
  [`scripts/check-licenses.mjs`](scripts/check-licenses.mjs).

The full conventions (architecture, stability rules, what instrumentation may and may not do) are in
[AGENTS.md](AGENTS.md). Despite the name, it is written for human contributors and AI coding agents alike.

## Reviews

hashspan is maintained by a single maintainer, so a review can take a few days. If a pull request has had no response
for a week, feel free to leave a friendly ping on it. Review comments are suggestions for making the change fit the
project, not a judgement of your work.

## AI-assisted contributions

You may use AI coding tools, but you are responsible for what you submit: you understand every change, have run the
checks above, and can explain and adjust it in review. Pull requests that look generated without that care may be
closed.

## License

hashspan is licensed under [Apache-2.0](LICENSE). By submitting a contribution, you agree that it is licensed under
the same terms (section 5 of the license); no separate CLA is required.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Please be kind and assume good intent.
