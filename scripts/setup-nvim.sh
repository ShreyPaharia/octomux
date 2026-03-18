#!/usr/bin/env bash
# One-command bootstrap for the repo-local neovim + LazyVim setup.
# Installs neovim if missing (macOS via Homebrew), then syncs all plugins headlessly.
# Idempotent — safe to run multiple times.
#
# Usage: ./scripts/setup-nvim.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── 1. Install neovim if missing ────────────────────────────────────────────

if ! command -v nvim >/dev/null 2>&1; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "Neovim not found. Installing via Homebrew..."
    if command -v brew >/dev/null 2>&1; then
      brew install neovim
    else
      echo "Error: Homebrew not found. Install neovim manually: https://github.com/neovim/neovim/blob/master/INSTALL.md" >&2
      exit 1
    fi
  else
    echo "Error: Neovim not found. Install it manually: https://github.com/neovim/neovim/blob/master/INSTALL.md" >&2
    exit 1
  fi
fi

# ─── 2. Verify neovim version ────────────────────────────────────────────────

NVIM_VERSION="$(nvim --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
NVIM_MAJOR="$(echo "$NVIM_VERSION" | cut -d. -f1)"
NVIM_MINOR="$(echo "$NVIM_VERSION" | cut -d. -f2)"

if [[ "$NVIM_MAJOR" -eq 0 && "$NVIM_MINOR" -lt 10 ]]; then
  echo "Error: Neovim >= 0.10.0 required (found $NVIM_VERSION). Please upgrade." >&2
  exit 1
fi

echo "Found neovim $NVIM_VERSION"

# ─── 3. Sync plugins headlessly ──────────────────────────────────────────────

export XDG_CONFIG_HOME="$REPO_ROOT/.config"
export XDG_DATA_HOME="$REPO_ROOT/.local/share"
export XDG_STATE_HOME="$REPO_ROOT/.local/state"
export XDG_CACHE_HOME="$REPO_ROOT/.local/cache"

echo "Syncing LazyVim plugins (this may take a minute on first run)..."
nvim --headless "+Lazy! sync" +qa

echo "Done! Use ./scripts/nvim.sh to launch neovim with the repo config."
