# Octomux npm Launch Design

## Overview

Productize octomux-agents as a publicly installable npm package called `octomux`. Users install via `npm install -g octomux`, run `octomux start` to launch the dashboard, and use `octomux <command>` for CLI operations. macOS only at launch. Compiled JS is visible but not source TypeScript. Separate landing page at octomux.dev.

### Prerequisites (end user)
- macOS (ARM64 or x64)
- Node.js 20+ (with npm)
- Xcode Command Line Tools (`xcode-select --install`) — required for native module compilation (better-sqlite3, node-pty)
- tmux (`brew install tmux`)
- git (`brew install git`)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

## 1. Package Rename & Bin Consolidation

### Package Identity
- **name:** `octomux`
- **version:** `1.0.0`
- **license:** ISC (permissive, npm default — decide before publish if you want something else)

### Single Binary
Merge the two existing binaries (`octomux-agents` for dashboard, `octomux` for CLI) into one unified command:

- `octomux start` — launches the dashboard (Express server + serves frontend)
- `octomux create-task` — creates a task
- `octomux list-tasks` — lists tasks
- `octomux get-task <id>` — gets task details
- `octomux close-task <id>` — closes a task
- `octomux delete-task <id>` — deletes a task
- `octomux resume-task <id>` — resumes a task
- `octomux add-agent <task-id>` — adds an agent
- `octomux send-message <task-id> <agent-id> "msg"` — sends a message
- `octomux init` — scaffolds `.claude/` settings in current repo

The `start` command absorbs the current `bin/octomux-agents.js` logic (preflight checks, server startup). All other commands absorb the current CLI tool.

### Files Published to npm
```
bin/octomux.js          # Entry point (shebang, preflight, starts server or routes to CLI)
dist/                   # Vite frontend build (minified)
dist-server/            # Server JS (bundled/minified via esbuild)
cli/dist/               # CLI JS
cli/package.json
```

Test files excluded from dist-server via existing `"files"` config.

### package.json Changes
```json
{
  "name": "octomux",
  "version": "1.0.0",
  "bin": {
    "octomux": "./bin/octomux.js"
  },
  "files": [
    "bin/",
    "dist/",
    "dist-server/",
    "!dist-server/*.test.*",
    "!dist-server/test-helpers.*",
    "cli/dist/",
    "cli/package.json"
  ],
  "engines": {
    "node": ">=20"
  }
}
```

## 2. Build Pipeline

### Current State
- `vite build` → `dist/` (frontend, already minified)
- `tsc` → `dist-server/` (server, no minification)
- `tsc` → `cli/dist/` (CLI, no minification)

### Changes
- Replace server `tsc` build with **tsup** to produce a bundled + minified `dist-server/index.js`
- **Critical:** Native addons (`better-sqlite3`, `node-pty`) and `ws` must be marked as external — they cannot be bundled:
  ```
  tsup server/index.ts --format esm --minify --out-dir dist-server \
    --external better-sqlite3 --external node-pty --external ws
  ```
- CLI build remains `tsc` (small output, not worth bundling)
- Keep `"prepublishOnly": "bun run build"` to ensure clean builds before publish
- All CLI runtime deps (`commander`, `chalk`) must be in root `package.json` `dependencies` after bin consolidation

## 3. First-Run Experience

### `octomux start [--port <port>] [--no-open]`
1. Print welcome banner (version read from package.json at runtime, not hardcoded):
   ```
   🐙 octomux v1.0.0
   ```
2. Run preflight checks (existing logic):
   - `tmux` installed → if not, print: `tmux is required. Install with: brew install tmux`
   - `git` installed → if not, print: `git is required. Install with: brew install git`
   - `claude` CLI installed → if not, print: `Claude Code CLI is required. See: https://docs.anthropic.com/en/docs/claude-code`
3. Install Claude Code skills (if not already present):
   - Check if `~/.claude/skills/octomux-create-task/` exists
   - If not, copy generalized skill files from the package's bundled `skills/` directory to `~/.claude/skills/`
   - Skills shipped: `octomux-create-task`, `octomux-create-pr`, `octomux-create-commit`
   - Skills use `octomux <command>` (not hardcoded paths) so they work for any user
   - Print: `Installed octomux skills for Claude Code` (silent if already installed)
4. Start Express server on `--port` or `PORT` env var (default 7777)
   - Detect EADDRINUSE and print: `Port 7777 is in use. Try: octomux start --port 8080`
5. Auto-open browser: `exec('open http://localhost:<port>')` on macOS (skip if `--no-open`)
6. Print: `Dashboard running at http://localhost:<port> — press Ctrl+C to stop`

### CLI commands (all except `start`)
All CLI commands require a running server. Before making HTTP requests, check connectivity and print a helpful error if the server is unreachable:
```
Error: Cannot connect to octomux server at http://localhost:7777
Start it with: octomux start
```

## 4. CI/CD via GitHub Actions

### Workflow: `ci.yml` (on push to main + PRs)
```yaml
jobs:
  test:
    runs-on: macos-latest
    steps:
      - checkout
      - setup bun
      - bun install
      - bun run lint
      - bun run typecheck
      - bun run test
      - bun run build
```

### Workflow: `publish.yml` (on tag `v*`)
```yaml
jobs:
  publish:
    runs-on: macos-latest
    steps:
      - checkout
      - setup bun
      - setup node (for npm publish)
      - bun install
      - bun run lint
      - bun run typecheck
      - bun run test
      - bun run build
      - npm publish
      - create GitHub Release with changelog
    env:
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Versioning
- Semver: `1.0.0` at launch
- Bump via `npm version patch|minor|major` which creates a git tag
- Push tag to trigger publish workflow
- Auto-generate changelog from conventional commits using `conventional-changelog-cli`

## 5. Bundled Skills

### Purpose
Ship Claude Code skills inside the npm package so users get slash commands (`/octomux-create-task`, etc.) automatically.

### Skills to bundle
Package includes a `skills/` directory with generalized versions of:
- `octomux-create-task/SKILL.md` — create tasks from within Claude Code
- `octomux-create-pr/SKILL.md` — create PRs for completed tasks
- `octomux-create-commit/SKILL.md` — generate conventional commits

### Generalization
Current skills reference hardcoded paths like `/Users/shreypaharia/.../cli/dist/index.js`. Generalized versions use `octomux <command>` (the globally installed binary). Remove any user-specific repo path mappings — let the skill query the API for recent repos instead.

### Installation logic (in `octomux start`)
```js
const skillsDir = path.join(os.homedir(), '.claude', 'skills');
const bundledSkills = path.join(__dirname, '..', 'skills');
for (const skill of fs.readdirSync(bundledSkills)) {
  const target = path.join(skillsDir, skill);
  if (!fs.existsSync(target)) {
    fs.cpSync(path.join(bundledSkills, skill), target, { recursive: true });
  }
}
```

### Package.json update
Add `"skills/"` to the `files` array so skills are included in the npm tarball.

## 6. Landing Page (octomux.dev)

### Separate Repo
- Repo: `octomux-site` (or `octomux.dev`)
- Hosted on Vercel (free tier, auto-deploys from main)
- Domain: `octomux.dev` (primary), grab `octomux.com` and redirect

### Tech
- Astro or plain HTML + Tailwind CDN (keep it simple, static)
- Single page, no JS framework needed

### Sections
1. **Hero:** Logo + tagline + `npm install -g octomux` install command + demo GIF
2. **What it does:** 3-4 feature cards (multi-agent orchestration, live terminals, git worktree isolation, CLI control)
3. **How it works:** Brief flow diagram or 3-step explanation
4. **Install:** Prerequisites (macOS, tmux, git, Claude Code CLI) + install command + quick start
5. **Footer:** GitHub link, npm link

### Logo
- Use the approved octopus circuit-node logo (`octomux.png`)
- Generate favicon, og:image, and Apple touch icon from it
- Dark blue on white (primary), white on dark (inverted for dark sections)

### Demo GIF/Video
- Record a terminal session: `octomux start` → create task → watch agents work → PR created
- Use a tool like `vhs` (charm.sh) or screen recording + gif conversion
- Keep under 15 seconds

## 7. README Rewrite

Replace the current developer-focused README with a user-focused one:

```markdown
# octomux

Orchestrate autonomous Claude Code agents from a web dashboard.
Create tasks, watch agents work in live terminals, get PRs.

## Install

Prerequisites: macOS, Node.js 20+, tmux, git, Claude Code CLI

npm install -g octomux

## Quick Start

cd your-project
octomux init        # scaffold settings
octomux start       # open dashboard

## CLI

octomux create-task -t "Add auth" -d "Add JWT auth to API" -r .
octomux list-tasks
octomux close-task <id>
```

Keep the developer/contributor docs in a separate `CONTRIBUTING.md`.

## 8. Data Storage

### Problem
Currently the SQLite database is stored at `<package-root>/data/tasks.db` (relative to `__dirname`). When installed globally via npm, this resolves to inside `node_modules/`, which is:
- Potentially not writable without `sudo`
- Destroyed on package update (`npm update -g octomux`)

### Solution
Move data to `~/.octomux/`:
```
~/.octomux/
  data/tasks.db      # SQLite database
```

- On first run, create `~/.octomux/data/` if it doesn't exist
- Update `server/db.ts` to resolve DB path from `os.homedir()` instead of `__dirname`
- In development (`NODE_ENV !== 'production'`), keep current behavior (relative `data/` dir) for convenience

### Upgrade Path
If a user has data in the old location (package-relative `data/`), detect it on startup and print a message suggesting they copy it to `~/.octomux/data/`. Don't auto-migrate — just inform.

## 9. postinstall & Native Modules

### Problem
`better-sqlite3` and `node-pty` are native C++ addons. They require compilation via `node-gyp` which needs Xcode Command Line Tools. The current `postinstall` script only handles `darwin-arm64`.

### Solution
- Update postinstall to handle both `darwin-arm64` and `darwin-x64`:
  ```
  chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true
  ```
- Add Xcode CLT to the prerequisites in README and landing page
- If `npm install` fails due to native compilation, the error from npm is already descriptive — no custom handling needed

## 10. What's NOT in v1

- No Windows/Linux support
- No Homebrew tap
- No auto-updater
- No telemetry
- No authentication/multi-user
- No Docker image
- No obfuscation beyond standard minification

## 11. Publish Verification

Before every publish, run `npm pack --dry-run` to verify package contents. Ensure:
- No `data/tasks.db` or `.env` files
- No source TypeScript (only compiled JS)
- No test files in dist-server
- No `.claude/` settings or user-specific config

## 12. Migration Checklist

### Package & Build
- [ ] Rename package in package.json to `octomux`
- [ ] Set license field (ISC or chosen license)
- [ ] Consolidate bins into single `octomux` command with `start` subcommand
- [ ] Move CLI runtime deps (`commander`, `chalk`) to root package.json `dependencies`
- [ ] Add tsup for server bundling with native module externals
- [ ] Add `engines` field requiring Node 20+
- [ ] Update postinstall to handle darwin-x64 and darwin-arm64

### Data & Runtime
- [ ] Move database path to `~/.octomux/data/tasks.db` in production
- [ ] Add old-location detection with migration message
- [ ] Read version from package.json at runtime (not hardcoded)

### CLI & UX
- [ ] Implement `octomux start` with `--port` and `--no-open` flags
- [ ] Add welcome banner with version
- [ ] Auto-open browser on start (macOS `open` command)
- [ ] Add EADDRINUSE detection with helpful error
- [ ] Add server connectivity check to CLI commands
- [ ] Auto-install Claude Code skills on `octomux start` (if not present)

### Skills
- [ ] Generalize skills (replace hardcoded paths with `octomux` CLI commands)
- [ ] Create `skills/` directory in package with bundled skill markdown files
- [ ] Add `"skills/"` to `files` array in package.json
- [ ] Add skill install logic to `octomux start` (copy to `~/.claude/skills/`)

### CI/CD
- [ ] Create `.github/workflows/ci.yml`
- [ ] Create `.github/workflows/publish.yml`
- [ ] Install `conventional-changelog-cli` for changelog generation

### Docs
- [ ] Rewrite README for end users (include Xcode CLT prereq)
- [ ] Move contributor docs to CONTRIBUTING.md
- [ ] Update CLAUDE.md with new package name and binary

### Landing Page (separate repo)
- [ ] Create `octomux-site` repo
- [ ] Build landing page (hero, features, install, demo)
- [ ] Generate favicon and og:image from logo
- [ ] Record demo GIF

### Launch
- [ ] Run `npm pack --dry-run` and verify contents
- [ ] Register npm account and reserve `octomux` package name
- [ ] Buy octomux.dev domain
- [ ] Configure Vercel for octomux.dev
- [ ] Publish v1.0.0 to npm
