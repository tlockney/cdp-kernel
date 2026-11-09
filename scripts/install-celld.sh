#!/bin/sh
# Installs the celld release CI pins. celld isn't on npm; its own
# installer puts it in ~/.local/bin, where the kernel looks first (#25),
# so this does too (or in the directory given as $1). The download is
# checked against the SHA-256 recorded here, so a changed release asset
# fails the job instead of running.
#
# To move the pin: set `version`, download each asset from
# https://github.com/denoland/celld/releases and record
# `shasum -a 256 <asset>`. docs/support.md and docs/install.md name the
# version, and container/Dockerfile has its own (CELLD_VERSION).
set -eu

version=0.6.2
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    asset=celld-x86_64-unknown-linux-gnu.gz
    sha256=ce0ee3552cc8d55dde3998dc3b1b0c8f547bbcb4bc803d2a94842368b047646c
    ;;
  Darwin-arm64)
    asset=celld-aarch64-apple-darwin.gz
    sha256=b81a38299800679e9651fd7c1544540185682dcb59eed1a24c8cc36c6b31e76d
    ;;
  *)
    echo "install-celld.sh: no pinned celld for $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

dir=${1:-$HOME/.local/bin}
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp" "https://github.com/denoland/celld/releases/download/v$version/$asset"
if command -v sha256sum > /dev/null 2>&1; then
  actual=$(sha256sum "$tmp" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
fi
if [ "$actual" != "$sha256" ]; then
  echo "install-celld.sh: $asset (v$version) has sha256 $actual, expected $sha256" >&2
  exit 1
fi

mkdir -p "$dir"
gunzip -c "$tmp" > "$dir/celld"
chmod +x "$dir/celld"
"$dir/celld" --version
