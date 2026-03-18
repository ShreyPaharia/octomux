#!/usr/bin/env bash
# Launches neovim with the repo-local LazyVim config.
# All XDG dirs are scoped to this repo to avoid collisions with personal nvim configs.
#
# Usage: ./scripts/nvim.sh [file ...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export XDG_CONFIG_HOME="$REPO_ROOT/.config"
export XDG_DATA_HOME="$REPO_ROOT/.local/share"
export XDG_STATE_HOME="$REPO_ROOT/.local/state"
export XDG_CACHE_HOME="$REPO_ROOT/.local/cache"

exec nvim "$@"
