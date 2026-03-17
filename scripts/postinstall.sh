#!/usr/bin/env bash
# postinstall.sh — runs after npm/bun install
# Installs subdirectory deps, fixes node-pty, and installs missing system deps.
# Never exits non-zero — failures print warnings but don't block install.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── 1. Install cli/ subdirectory dependencies ──────────────────────────────

if [ -d "$ROOT_DIR/cli" ] && [ -f "$ROOT_DIR/cli/package.json" ]; then
  if [ ! -d "$ROOT_DIR/cli/node_modules" ]; then
    echo "Installing cli/ dependencies..."
    (cd "$ROOT_DIR/cli" && npm install --ignore-scripts 2>/dev/null) || {
      echo "⚠  Could not install cli/ dependencies. Run manually: cd cli && npm install"
    }
  fi
fi

# ─── 2. Fix node-pty spawn-helper permissions (macOS) ────────────────────────

chmod +x "$ROOT_DIR/node_modules/node-pty/prebuilds/darwin-"*/spawn-helper 2>/dev/null || true

# ─── 3. Install missing system dependencies ──────────────────────────────────

install_with_brew() {
  local pkg="$1"
  local name="$2"
  local hint="$3"

  if command -v "$pkg" >/dev/null 2>&1; then
    return 0
  fi

  echo "$name not found. Attempting to install..."

  if command -v brew >/dev/null 2>&1; then
    if brew install "$pkg" 2>/dev/null; then
      echo "✓ Installed $name via Homebrew"
      return 0
    fi
  fi

  echo "⚠  Could not install $name automatically. $hint"
}

install_with_npm_global() {
  local cmd="$1"
  local pkg="$2"
  local name="$3"
  local hint="$4"

  if command -v "$cmd" >/dev/null 2>&1; then
    return 0
  fi

  echo "$name not found. Attempting to install..."

  if npm install -g "$pkg" 2>/dev/null; then
    echo "✓ Installed $name via npm"
    return 0
  fi

  echo "⚠  Could not install $name automatically. $hint"
}

# tmux
install_with_brew "tmux" "tmux" "Install with: brew install tmux"

# git
install_with_brew "git" "git" "Install with: brew install git"

# Claude Code CLI
install_with_npm_global "claude" "@anthropic-ai/claude-code" "Claude Code CLI" \
  "See: https://docs.anthropic.com/en/docs/claude-code"
