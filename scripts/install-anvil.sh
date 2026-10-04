#!/usr/bin/env bash
# Installs a pinned Anvil binary into ./.tools/bin (project-local, gitignored).
# Removing .tools/ (or `make lab-nuke`) uninstalls it; nothing outside the repo is touched.
set -euo pipefail

VERSION="${FOUNDRY_VERSION:-v1.8.4}"
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

# SHA-256 of each release archive, pinned here rather than read from the release, so a replaced release asset is
# caught. Checked against Foundry's build attestations (`gh attestation verify <file> --repo foundry-rs/foundry`)
# when added. Add a line per platform when bumping VERSION.
pinned_sha256() {
  case "$1" in
    v1.8.4_darwin_arm64) echo b6a1b35d85c6b7dbe4b34ccf6c389407d530f906b56c319a5c74c7eec854de3b ;;
    v1.8.4_darwin_amd64) echo a4ba162f6e3677878b717643fcb247c7dbe31e8007c7645564626161cb7d2053 ;;
    v1.8.4_linux_amd64) echo 699e2207a6a9b27ca17c48c81e56f1677ed9c58b623b59128b4e15ec9da0625e ;;
    v1.8.4_linux_arm64) echo d998f88314c057dc37c1de9a2044f49b273505965ff94bea5c3c5aefa9d1debd ;;
    *) return 1 ;;
  esac
}
if ! expected="$(pinned_sha256 "${VERSION}_${os}_${arch}")"; then
  echo "no pinned checksum for foundry ${VERSION} on ${os}/${arch}; add it to $0" >&2
  exit 1
fi

asset="foundry_${VERSION}_${os}_${arch}.tar.gz"
base="https://github.com/foundry-rs/foundry/releases/download/${VERSION}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$base/$asset" -o "$tmp/$asset"
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
