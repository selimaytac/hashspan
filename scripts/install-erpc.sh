#!/usr/bin/env bash
# Installs a pinned eRPC binary (an EVM JSON-RPC gateway, Apache-2.0) into ./.tools/bin (project-local, gitignored),
# for integrations/test/erpc.int.test.ts. Removing .tools/ (or `make lab-nuke`) uninstalls it; nothing outside the
# repo is touched. The test runs it on 127.0.0.1 only, in front of Anvil.
set -euo pipefail

VERSION="${ERPC_VERSION:-0.4.0}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/.tools/bin"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64) arch=x86_64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

if [[ -x "$DEST/erpc" ]] && [[ "$("$DEST/erpc" --version)" == "erpc version ${VERSION}" ]]; then
  echo "erpc ${VERSION} already installed at $DEST/erpc"
  exit 0
fi

# SHA-256 of each release binary, pinned here rather than read from the release, so a replaced release asset is
# caught. Checked against the release's checksums.txt and the asset digests GitHub lists when added. Add a line per
# platform when bumping VERSION.
pinned_sha256() {
  case "$1" in
    0.4.0_darwin_arm64) echo dcb194bf8cc512e86fb147aa65f24a9dc9198aa0a1315900e2cce6abd09aefb3 ;;
    0.4.0_darwin_x86_64) echo d2bf7d9240fcc13b9532e4bfbe3e9da2130b8d8916abc7f06e0af7f82f75ec84 ;;
    0.4.0_linux_arm64) echo f1c01f8dcfe4b68e58d9e5d8f391b3f0394ef4626059ada40c976fd6b47ce340 ;;
    0.4.0_linux_x86_64) echo bb4658b11bb1333e943b4e6f8819da26e1ed7e84b8c72305cbdc1a30cc4ea5f1 ;;
    *) return 1 ;;
  esac
}
if ! expected="$(pinned_sha256 "${VERSION}_${os}_${arch}")"; then
  echo "no pinned checksum for erpc ${VERSION} on ${os}/${arch}; add it to $0" >&2
  exit 1
fi

# The release assets are plain binaries, not archives.
asset="erpc_${os}_${arch}"
base="https://github.com/erpc/erpc/releases/download/${VERSION}"
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
mv "$tmp/$asset" "$DEST/erpc"
chmod +x "$DEST/erpc"
"$DEST/erpc" --version
