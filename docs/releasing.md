# Releasing

Releases are cut from `main`, and only from `main`, by the [Release workflow](../.github/workflows/release.yml), using
[Changesets](https://github.com/changesets/changesets). Packages are published to npm with
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers/): GitHub Actions authenticates with a short-lived
OIDC token, npm adds a provenance attestation, and no npm token exists anywhere. `@hashspan/*` packages are versioned
together.

## Every release

1. Merge pull requests with their changesets (`pnpm changeset`) into `main`.
2. Run the **Release** workflow (Actions, Release, Run workflow). It runs the CI checks, then opens or updates a
   **Version packages** pull request that bumps the versions and writes `CHANGELOG.md` from the changesets. This step needs no
   approval: only the job that publishes to npm runs in the `npm` environment.
3. Review and merge that pull request. It is opened by GitHub Actions, so CI does not run on it; the next step runs
   the checks again before publishing.
4. Run the **Release** workflow again. With no changesets left, it runs the checks, then waits for a maintainer to
   approve the `npm` environment deployment (Actions run page, Review deployments). Once approved, it publishes the new
   versions to npm, pushes the git tags and creates the GitHub releases.
5. Check the result: `npm view @hashspan/core` shows the version, and the npm page shows the provenance badge.

## One-time setup

Done once, by a maintainer, before the first release of each package (steps 1 and 3 again for a new package).

**1. Reserve the package names.** npm can only attach a trusted publisher to a package that exists, so each package
gets a `0.0.0` placeholder. Use npm 11.10 or later, and a machine and account you trust with your npm login:

```sh
npm login
dir="$(mktemp -d)"
for pkg in core viem cdp; do
  mkdir "$dir/$pkg"
  cat > "$dir/$pkg/package.json" <<JSON
{
  "name": "@hashspan/$pkg",
  "version": "0.0.0",
  "description": "Placeholder; see https://github.com/selimaytac/hashspan",
  "license": "Apache-2.0",
  "repository": { "type": "git", "url": "git+https://github.com/selimaytac/hashspan.git" }
}
JSON
  (cd "$dir/$pkg" && npm publish --access public)
done
```

**2. Restrict releases to `main`.** Protect `main` with a ruleset: pull requests required (squash merge, no
required approvals and no required status checks, since the version pull request opened by GitHub Actions runs no CI),
force pushes and deletion blocked, no bypass. Then create a GitHub environment named `npm` (Settings, Environments)
with deployment branches limited to `main` and a maintainer as required reviewer. The release job runs in that environment, so GitHub refuses to run it from any
other branch, even if the workflow file is changed there.

**3. Trust the Release workflow.** For each package, allow publishing from this repository's `release.yml` in the
`npm` environment:

```sh
npm trust github @hashspan/core --repo selimaytac/hashspan --file release.yml --env npm --allow-publish
npm trust github @hashspan/viem --repo selimaytac/hashspan --file release.yml --env npm --allow-publish
npm trust github @hashspan/cdp --repo selimaytac/hashspan --file release.yml --env npm --allow-publish
npm trust list @hashspan/core
npm logout
```

The same can be done on npmjs.com (package, Settings, Trusted publisher). Allow `npm publish`, not only staged
publishing, and set the environment to `npm`: npm then rejects publishes from any other environment.

**4. Lock down tokens.** On npmjs.com, set each package's publishing access to require two-factor authentication and
disallow tokens, so the trusted publisher is the only way to publish.

**5. Let the workflow open the version pull request, and watch dependencies.** In the repository settings (Actions, General, Workflow
permissions), enable "Allow GitHub Actions to create and approve pull requests". Under Code security, enable
Dependabot alerts and security updates.

After the first real release, deprecate the placeholders:
`npm deprecate @hashspan/core@0.0.0 "Placeholder; use a later version"` (and the same for `@hashspan/viem`).
