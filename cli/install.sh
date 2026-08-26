#!/bin/sh
# stift installer — https://stift.sh/install.sh
#
# Usage:
#   curl -fsSL https://stift.sh/install.sh | sh
#
# Environment overrides:
#   STIFT_VERSION      version to install (default: latest)
#   STIFT_INSTALL_DIR  where to put the binary (default: /usr/local/bin if
#                      writable, otherwise ~/.local/bin)
#   STIFT_BASE_URL     mirror serving $STIFT_BASE_URL/$VERSION/stift-<os>-<arch>
#                      (default: GitHub releases of stift-sh/stift)
#
# Binaries are published by GoReleaser with a .sha256 file next to each.

set -eu

VERSION="${STIFT_VERSION:-latest}"
if [ -n "${STIFT_BASE_URL:-}" ]; then
  BASE_URL="$STIFT_BASE_URL"; DL_URL="$BASE_URL/$VERSION"
elif [ "$VERSION" = latest ]; then
  BASE_URL="https://github.com/stift-sh/stift/releases"; DL_URL="$BASE_URL/latest/download"
else
  case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
  BASE_URL="https://github.com/stift-sh/stift/releases"; DL_URL="$BASE_URL/download/$VERSION"
fi

say()  { printf '%s\n' "$*" >&2; }
fail() { say "stift install: error: $*"; exit 1; }

# --- platform detection ------------------------------------------------------
os=$(uname -s 2>/dev/null || echo unknown)
case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  CYGWIN*|MINGW*|MSYS*)
    fail "this script does not support Windows. Download stift-windows-amd64.exe
from $DL_URL/ and put it on your PATH." ;;
  *) fail "unsupported operating system: $os" ;;
esac

arch=$(uname -m 2>/dev/null || echo unknown)
case "$arch" in
  x86_64|amd64)  arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "unsupported architecture: $arch (supported: amd64, arm64)" ;;
esac

artifact="stift-$os-$arch"
url="$DL_URL/$artifact"

# --- fetcher -----------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetch()       { curl -fsSL "$1" -o "$2"; }
  fetch_maybe() { curl -fsSL "$1" -o "$2" 2>/dev/null; }
elif command -v wget >/dev/null 2>&1; then
  fetch()       { wget -qO "$2" "$1"; }
  fetch_maybe() { wget -qO "$2" "$1" 2>/dev/null; }
else
  fail "need curl or wget"
fi

# --- install dir -------------------------------------------------------------
if [ -n "${STIFT_INSTALL_DIR:-}" ]; then
  dir="$STIFT_INSTALL_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  dir=/usr/local/bin
else
  dir="$HOME/.local/bin"
fi
mkdir -p "$dir" || fail "cannot create $dir"

# --- download ----------------------------------------------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "downloading $url"
fetch "$url" "$tmp/$artifact" || fail "download failed: $url"

# Verify the checksum when the server publishes one; warn if it doesn't.
if fetch_maybe "$url.sha256" "$tmp/$artifact.sha256"; then
  want=$(awk '{print $1}' "$tmp/$artifact.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$tmp/$artifact" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 "$tmp/$artifact" | awk '{print $1}')
  else
    got=""
    say "warning: no sha256sum/shasum tool found, skipping checksum verification"
  fi
  if [ -n "$got" ]; then
    [ "$got" = "$want" ] || fail "checksum mismatch for $artifact
  expected: $want
  got:      $got"
    say "checksum verified"
  fi
else
  say "warning: no checksum published at $url.sha256, skipping verification"
fi

chmod +x "$tmp/$artifact"
mv "$tmp/$artifact" "$dir/stift"

installed=$("$dir/stift" version 2>/dev/null) || fail "downloaded binary does not run on this machine"
say "installed $installed to $dir/stift"

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say ""
     say "note: $dir is not on your PATH. Add it with:"
     say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile  # or your shell's rc file"
     ;;
esac

say ""
say "next step — connect to your server:"
say "  stift login https://your-server:8580 --token stf_..."
