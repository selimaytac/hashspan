#!/usr/bin/env bash
# Installs the ERC-4337 bundler Alto and the EntryPoint v0.7 artifacts into ./.tools/bundler (project-local,
# gitignored), for packages/viem/test/real-bundler.int.test.ts. Removing .tools/ uninstalls them.
#
# They are kept out of the pnpm workspace on purpose: Alto is GPL-3.0-or-later and the EntryPoint sources are GPL-3.0,
# which the license check (scripts/check-licenses.mjs) rejects in the lockfile. Like the Anvil binary, they are tools
# the tests run, never a dependency of a published package. Versions and checksums of the whole tree are pinned by
# scripts/bundler/package-lock.json; `npm ci` refuses anything that does not match it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/bundler"
DEST="$ROOT/.tools/bundler"

if [[ -f "$DEST/package-lock.json" ]] && cmp -s "$SRC/package-lock.json" "$DEST/package-lock.json" &&
  [[ -f "$DEST/node_modules/@pimlico/alto/esm/cli/alto.js" ]]; then
  echo "bundler tools already installed at $DEST"
  exit 0
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC/package.json" "$SRC/package-lock.json" "$DEST/"
# No install scripts run: nothing in the tree needs one to start Alto or to read the artifacts.
npm ci --prefix "$DEST" --ignore-scripts --no-audit --no-fund --loglevel=error
node -e 'console.log(`alto ${require(process.argv[1]).version}`)' "$DEST/node_modules/@pimlico/alto/package.json"
