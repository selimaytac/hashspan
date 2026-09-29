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

# SHA-256 of each release archive, pinned here rather than read from the release, so a replaced release asset is
# caught. Checked against Foundry's build attestations (`gh attestation verify <file> --repo foundry-rs/foundry`)
# when added. Add a line per platform when bumping VERSION.
pinned_sha256() {
  case "$1" in
    v1.8.3_darwin_arm64) echo 562f9c2f9094e512f1efc1e005c79de7642c27ffc1e7e9dcf8e31baa54577d6e ;;
    v1.8.3_darwin_amd64) echo 1b469229681b31e3c66a07132811b99460b2874a0a48de3b29500234454f47b8 ;;
    v1.8.3_linux_amd64) echo 7ca48e6ca3cac1bce1403ca67e5bc1dc3bc1fd818199c9957c7165079c228568 ;;
    v1.8.3_linux_arm64) echo 93fc23be26c8a902ca58fe54aa6ca28c880b58af95d052674933161df7928e6d ;;
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
