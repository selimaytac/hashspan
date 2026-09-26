#!/usr/bin/env bash
# Installs a pinned Anvil binary into ./.tools/bin (project-local, gitignored).
# Removing .tools/ (or `make lab-nuke`) uninstalls it; nothing outside the repo is touched.
set -euo pipefail

VERSION="${FOUNDRY_VERSION:-v1.8.3}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/.tools/bin"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64) arch=amd64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

if [[ -x "$DEST/anvil" ]] && "$DEST/anvil" --version | grep -q "${VERSION#v}"; then
  echo "anvil ${VERSION} already installed at $DEST/anvil"
  exit 0
fi

asset="foundry_${VERSION}_${os}_${arch}.tar.gz"
base="https://github.com/foundry-rs/foundry/releases/download/${VERSION}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/foundry_${VERSION}_${os}_${arch}.sha256" -o "$tmp/sha256"
expected="$(awk '{print $1}' "$tmp/sha256" | head -1)"
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi
if [[ "$expected" != "$actual" ]]; then
  echo "checksum mismatch for $asset" >&2
  exit 1
fi

mkdir -p "$DEST"
tar -xzf "$tmp/$asset" -C "$tmp" anvil
mv "$tmp/anvil" "$DEST/anvil"
chmod +x "$DEST/anvil"
"$DEST/anvil" --version
