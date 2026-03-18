# Neovim + LazyVim Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repo-local LazyVim configuration with full XDG isolation and one-command bootstrap.

**Architecture:** LazyVim starter config committed in `.config/nvim/`, runtime plugin data in gitignored `.local/`. Two scripts: `setup-nvim.sh` (install + sync) and `nvim.sh` (wrapper). All four XDG variables scoped to repo root.

**Tech Stack:** Neovim, lazy.nvim, LazyVim, Lua, Bash

**Spec:** `docs/superpowers/specs/2026-03-19-nvim-lazyvim-setup-design.md`

---

## File Structure

```
Create: .config/nvim/init.lua                  # LazyVim entry point
Create: .config/nvim/lua/config/lazy.lua       # lazy.nvim bootstrap + LazyVim spec
Create: .config/nvim/lua/plugins/extras.lua    # TypeScript, Tailwind, ESLint extras
Create: .config/nvim/stylua.toml               # Lua formatter config
Create: scripts/nvim.sh                        # Wrapper script with XDG isolation
Create: scripts/setup-nvim.sh                  # Bootstrap script (install + sync)
Modify: .gitignore                             # Add .local/ and .config/nvim/.luarc.json
```

---

### Task 1: Create LazyVim config files

**Files:**
- Create: `.config/nvim/init.lua`
- Create: `.config/nvim/lua/config/lazy.lua`
- Create: `.config/nvim/lua/plugins/extras.lua`
- Create: `.config/nvim/stylua.toml`

- [ ] **Step 1: Create init.lua**

```lua
-- bootstrap lazy.nvim, LazyVim and your plugins
require("config.lazy")
```

Write to `.config/nvim/init.lua`.

- [ ] **Step 2: Create lua/config/lazy.lua**

```lua
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = "https://github.com/folke/lazy.nvim.git"
  local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath })
  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
      { out, "WarningMsg" },
      { "\nPress any key to exit..." },
    }, true, {})
    vim.fn.getchar()
    os.exit(1)
  end
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
  spec = {
    -- add LazyVim and import its plugins
    { "LazyVim/LazyVim", import = "lazyvim.plugins" },
    -- import/override with your plugins
    { import = "plugins" },
  },
  defaults = {
    -- By default, only LazyVim plugins will be lazy-loaded. Your custom plugins will load during startup.
    -- If you know what you're doing, you can set this to `true` to have all your custom plugins lazy-loaded by default.
    lazy = false,
    -- It's recommended to leave version=false for now, since a lot the plugin that support versioning,
    -- have outdated releases, which may break your Neovim install.
    version = false, -- always use the latest git commit
  },
  install = { colorscheme = { "tokyonight", "habamax" } },
  checker = {
    enabled = true, -- check for plugin updates periodically
    notify = false, -- notify on update
  },
  performance = {
    rtp = {
      -- disable some rtp plugins
      disabled_plugins = {
        "gzip",
        "tarPlugin",
        "tohtml",
        "tutor",
        "zipPlugin",
      },
    },
  },
})
```

Write to `.config/nvim/lua/config/lazy.lua`.

- [ ] **Step 3: Create lua/plugins/extras.lua**

```lua
return {
  { import = "lazyvim.plugins.extras.lang.typescript" },
  { import = "lazyvim.plugins.extras.lang.tailwind" },
  { import = "lazyvim.plugins.extras.linting.eslint" },
}
```

Write to `.config/nvim/lua/plugins/extras.lua`.

- [ ] **Step 4: Create stylua.toml**

```toml
indent_type = "Spaces"
indent_width = 2
column_width = 120
```

Write to `.config/nvim/stylua.toml`.

- [ ] **Step 5: Commit**

```bash
git add .config/nvim/
git commit -m "feat(nvim): add LazyVim starter config with TS/Tailwind/ESLint extras"
```

---

### Task 2: Create nvim.sh wrapper script

**Files:**
- Create: `scripts/nvim.sh`

- [ ] **Step 1: Create scripts/nvim.sh**

```bash
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
```

Write to `scripts/nvim.sh`.

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/nvim.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/nvim.sh
git commit -m "feat(nvim): add nvim.sh wrapper with XDG isolation"
```

---

### Task 3: Create setup-nvim.sh bootstrap script

**Files:**
- Create: `scripts/setup-nvim.sh`

- [ ] **Step 1: Create scripts/setup-nvim.sh**

```bash
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
```

Write to `scripts/setup-nvim.sh`.

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/setup-nvim.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-nvim.sh
git commit -m "feat(nvim): add setup-nvim.sh bootstrap script"
```

---

### Task 4: Update .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add .local/ and .luarc.json to .gitignore**

Append these lines to the end of `.gitignore`:

```
# Repo-local neovim runtime data
.local/
.config/nvim/.luarc.json
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore nvim runtime data and generated files"
```

---

### Task 5: Run setup and verify

- [ ] **Step 1: Run setup script**

```bash
./scripts/setup-nvim.sh
```

Expected: neovim is found (or installed), plugins sync successfully, prints "Done!" message.

- [ ] **Step 2: Verify nvim launches cleanly**

```bash
./scripts/nvim.sh --headless "+echo 'LazyVim OK'" +qa
```

Expected: exits cleanly with no errors.

- [ ] **Step 3: Verify lazy-lock.json was generated**

```bash
ls .config/nvim/lazy-lock.json
```

Expected: file exists with plugin version pins.

- [ ] **Step 4: Commit lazy-lock.json**

```bash
git add .config/nvim/lazy-lock.json
git commit -m "chore(nvim): add lazy-lock.json for reproducible plugin versions"
```

- [ ] **Step 5: Final verification — check git status is clean**

```bash
git status
```

Expected: working tree clean (except `.local/` which is gitignored).
