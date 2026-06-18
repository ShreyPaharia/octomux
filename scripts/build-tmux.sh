#!/usr/bin/env bash
# build-tmux.sh — Build a statically-linked tmux binary for the current platform.
#
# This script runs in CI (see .github/workflows/build-binaries.yml) on each
# supported platform/arch combination. It downloads pinned source tarballs for
# ncurses, libevent, and tmux; builds them statically; compiles a minimal
# terminfo database; smoke-tests the result; then copies the artifacts into the
# appropriate packages/tmux-<platform>-<arch>/ directory for npm publish.
#
# Usage (local):
#   bash scripts/build-tmux.sh
#
# Requires: gcc/clang, make, curl, tic (part of ncurses), bzip2, pkg-config.
# On macOS: Xcode CLT (xcode-select --install) is sufficient.
# On Linux: build-essential + libz-dev (or equivalent) is sufficient.

set -euo pipefail

# ─── Pinned versions ──────────────────────────────────────────────────────────
NCURSES_VERSION="6.5"
LIBEVENT_VERSION="2.1.12"
TMUX_VERSION="3.5a"

NCURSES_URL="https://ftp.gnu.org/pub/gnu/ncurses/ncurses-${NCURSES_VERSION}.tar.gz"
LIBEVENT_URL="https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}-stable/libevent-${LIBEVENT_VERSION}-stable.tar.gz"
TMUX_URL="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"

# ─── Platform detection ───────────────────────────────────────────────────────
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"   # darwin | linux
ARCH="$(uname -m)"                                     # arm64 | x86_64

# Node uses 'x64' for x86_64; normalise to match npm package naming.
if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
fi

PKG_NAME="tmux-${PLATFORM}-${ARCH}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$ROOT_DIR/packages/$PKG_NAME"

echo "Building tmux ${TMUX_VERSION} for ${PLATFORM}/${ARCH}"
echo "Destination: ${DEST_DIR}"

# ─── Working directory ────────────────────────────────────────────────────────
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
INSTALL_PREFIX="$BUILD_DIR/prefix"
mkdir -p "$INSTALL_PREFIX"

# ─── Helper: download and extract ────────────────────────────────────────────
fetch_and_extract() {
  local url="$1"
  local outdir="$2"
  local tarball="$BUILD_DIR/$(basename "$url")"
  echo "  Downloading $url ..."
  curl -fsSL "$url" -o "$tarball"
  mkdir -p "$outdir"
  tar -xzf "$tarball" -C "$outdir" --strip-components=1
}

# ─── 1. Build ncurses (static, no shared libs) ────────────────────────────────
echo ""
echo "==> Building ncurses ${NCURSES_VERSION} ..."
NCURSES_SRC="$BUILD_DIR/ncurses"
fetch_and_extract "$NCURSES_URL" "$NCURSES_SRC"

(
  cd "$NCURSES_SRC"
  ./configure \
    --prefix="$INSTALL_PREFIX" \
    --without-shared \
    --without-debug \
    --without-ada \
    --without-tests \
    --enable-widec \
    --disable-stripping \
    --with-default-terminfo-dir=/usr/share/terminfo
  make -j"$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
  make install
)

# ─── 2. Build libevent (static, no openssl) ───────────────────────────────────
echo ""
echo "==> Building libevent ${LIBEVENT_VERSION} ..."
LIBEVENT_SRC="$BUILD_DIR/libevent"
fetch_and_extract "$LIBEVENT_URL" "$LIBEVENT_SRC"

(
  cd "$LIBEVENT_SRC"
  ./configure \
    --prefix="$INSTALL_PREFIX" \
    --disable-shared \
    --enable-static \
    --disable-openssl \
    --disable-samples \
    --disable-debug-mode
  make -j"$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
  make install
)

# ─── 3. Build tmux ────────────────────────────────────────────────────────────
echo ""
echo "==> Building tmux ${TMUX_VERSION} ..."
TMUX_SRC="$BUILD_DIR/tmux"
fetch_and_extract "$TMUX_URL" "$TMUX_SRC"

(
  cd "$TMUX_SRC"

  CFLAGS="-I${INSTALL_PREFIX}/include -I${INSTALL_PREFIX}/include/ncursesw"
  LDFLAGS="-L${INSTALL_PREFIX}/lib"
  LIBS="-lncursesw"

  if [ "$PLATFORM" = "linux" ]; then
    # On Linux we can fully static-link (libSystem equivalent is glibc musl).
    LDFLAGS="$LDFLAGS -static"
  fi

  PKG_CONFIG_PATH="$INSTALL_PREFIX/lib/pkgconfig" \
    CFLAGS="$CFLAGS" \
    LDFLAGS="$LDFLAGS" \
    LIBS="$LIBS" \
    ./configure \
      --prefix="$INSTALL_PREFIX" \
      --enable-static
  make -j"$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
  make install
)

# ─── 4. Compile minimal terminfo entries ─────────────────────────────────────
echo ""
echo "==> Compiling terminfo entries ..."
TERMINFO_DIR="$BUILD_DIR/terminfo"
mkdir -p "$TERMINFO_DIR"

# tic ships with ncurses; use the just-built one if available.
TIC_BIN="$INSTALL_PREFIX/bin/tic"
if [ ! -x "$TIC_BIN" ]; then
  TIC_BIN="$(command -v tic)"
fi

for term in tmux-256color screen-256color xterm-256color; do
  # Compile from the system terminfo source (works on both macOS + Linux).
  if "$TIC_BIN" -x -o "$TERMINFO_DIR" "$(infocmp -x "$term" 2>/dev/null | head -1 | awk '{print $1}' || true)" 2>/dev/null; then
    echo "  ✓ $term (from infocmp)"
  else
    # Fallback: compile from /usr/share/terminfo source file if present.
    for src_dir in /usr/share/terminfo /lib/terminfo /etc/terminfo; do
      first_char="${term:0:1}"
      src_file="$src_dir/$first_char/$term"
      if [ -f "$src_file" ]; then
        TERMINFO="$TERMINFO_DIR" tic -x -o "$TERMINFO_DIR" "$src_file" 2>/dev/null && \
          echo "  ✓ $term (from $src_file)" && break || true
      fi
    done
  fi
done

# ─── 5. Smoke test ────────────────────────────────────────────────────────────
echo ""
echo "==> Smoke-testing tmux ..."
TMUX_BIN="$INSTALL_PREFIX/bin/tmux"
TMUX_SOCK="$BUILD_DIR/smoke.sock"

# Version check
"$TMUX_BIN" -V

# new-session + capture-pane round-trip on a private socket
"$TMUX_BIN" -S "$TMUX_SOCK" new-session -d -s smoke -x 80 -y 24
"$TMUX_BIN" -S "$TMUX_SOCK" send-keys -t smoke "echo hello-octomux" Enter
sleep 1
CAPTURED="$("$TMUX_BIN" -S "$TMUX_SOCK" capture-pane -p -t smoke)"
"$TMUX_BIN" -S "$TMUX_SOCK" kill-session -t smoke 2>/dev/null || true
rm -f "$TMUX_SOCK"

if echo "$CAPTURED" | grep -q "hello-octomux"; then
  echo "  ✓ capture-pane round-trip passed"
else
  echo "  ✗ capture-pane output did not contain expected string"
  echo "  Output was: $CAPTURED"
  exit 1
fi

# ─── 6. Copy artifacts into packages/ ────────────────────────────────────────
echo ""
echo "==> Copying artifacts to $DEST_DIR ..."
mkdir -p "$DEST_DIR/bin" "$DEST_DIR/share/terminfo"

cp "$TMUX_BIN" "$DEST_DIR/bin/tmux"
chmod +x "$DEST_DIR/bin/tmux"

# Copy terminfo tree
if [ -d "$TERMINFO_DIR" ] && [ "$(ls -A "$TERMINFO_DIR" 2>/dev/null)" ]; then
  cp -r "$TERMINFO_DIR/." "$DEST_DIR/share/terminfo/"
  echo "  ✓ terminfo entries copied"
else
  echo "  ⚠  No terminfo entries compiled — package will rely on system terminfo"
fi

echo ""
echo "==> Done. Artifacts:"
ls -lh "$DEST_DIR/bin/tmux"
"$DEST_DIR/bin/tmux" -V
