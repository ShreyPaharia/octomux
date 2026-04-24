# Liquid-Glass Implementation Backlog

Seven tasks that take the octomux React codebase from its current state to the
target state mocked in `design/glass-redesign.pen`. Each task is scoped to
~one-agent-session of work, with minimal file overlap.

**Dispatch order:** `T1` first (foundation — other tasks depend on its
primitives), then T2–T6 in parallel, then T7 last (integrates lifecycle/empty
states into surfaces touched by earlier tasks).

**All tasks share these constraints:**
- Repo: `/Users/shreypaharia/Documents/Projects/Ostium/octomux-agents`, base branch `main`.
- `bun run lint`, `bun run typecheck`, `bun run test` must pass.
- Conventional commits. No `Co-Authored-By` lines.
- Open a PR via `gh pr create` when done.
- Reference: `design/glass-redesign.pen` (mockups) + `design/review-snapshots/*.png` (rendered) + `design/README.md` (material spec).

---

## T1 · `feat/glass-design-system` — foundation (tokens, glyphs, focus ring) · **do first**

**Scope:** Only tokens and primitives. No page or layout changes.

- Tailwind tokens for L0/L1/L2/L3 glass (fill tints, blur radii, stroke colors, specular highlight).
- `--muted` bumped `#8a8a8a` → `#B5B5BD`; add `--muted-soft` `#8a8a8a` for tertiary.
- `focus-ring` utility: `:focus-visible` → `ring-2 ring-[#60A5FAE6] ring-offset-2 ring-offset-[#07080B]`.
- `<GlassPanel level={1|2|3} specular?>` primitive at `src/components/ui/glass-panel.tsx`.
- `<StatusGlyph status>` primitive at `src/components/ui/status-glyph.tsx` — ● ▲ ◐ ✕ ○ shape+color per status.
- Update `StatusBadge` to include the glyph in pill text by default (`● RUNNING`).
- Unit tests for all three primitives.

**PR title:** `feat(ui): glass design system foundation`

---

## T2 · `feat/glass-sidebar` — inset-pill sidebar + shortcuts + footer

**File:** `src/components/UniversalSidebar.tsx` (+ test file).

- Convert nav rows and task rows to **inset pills** (12px inset, 10px radius). Active row = `#3B82F61F` fill + 1px `#3B82F666` stroke, no left accent bar.
- Panel itself uses L1 glass material (`<GlassPanel level={1} specular>`).
- Add keyboard shortcut keycaps on nav items: ⌘1 Home, ⌘2 Tasks, ⌘3 Orchestrator, ⌘, Settings.
- Orchestrator "running" indicator = green dot badge on the icon's top-right when collapsed (iOS-style).
- Session row uses `<StatusGlyph>` from T1; `⋯` overflow button visible on hover, opens existing `RowMenu`.
- Nucleus/repo group headers gain a count chip (`4`) and reveal a `+` button on hover.
- Sidebar footer: user avatar + handle + connection dot + disclosure for settings/sign-out.
- Collapsed state (56px): icon rail with 36px rounded tiles; active tile = cyan-tinted glass.

**PR title:** `feat(ui): glass sidebar with inset pills and keycaps`

---

## T3 · `feat/glass-home-tasks` — Home + Tasks glass pass

**Files:** `src/pages/HomePage.tsx`, `src/pages/TasksPage.tsx`, `src/components/SessionsInbox.tsx`, `src/components/TaskList.tsx`, `src/components/TaskFilterBar.tsx`.

- Both pages gain eyebrow pattern: `// INBOX` / `// TASKS` JetBrains Mono 11px + sentence-case H1 32px (down from 42px).
- Tasks `NEW TASK` button: solid `#3B82F6` with cyan glow shadow, inner white specular.
- Filter bar becomes **one unified L1 glass panel** with segmented pills; active chip = "pressed" state (14% white fill, 1px inner stroke).
- Task cards → `<GlassPanel level={2}>`, 14px radius, shadow (y:12 blur:30 spread:-8).
- Each task card carries a telemetry footer line: `opus-4.7 · 412k/1M ctx · $2.14 · +18 −4 · tests 24/24 · lint clean` (placeholder values from API; wire what's available).
- Home inbox: rename `NEEDS YOU` → `AWAITING REPLY` (amber); add `ERRORED` sub-bucket (red triangle). Collapse `ACTIVITY` behind a `· tap to expand` disclosure.
- Inline `Reply →` button on inbox cards (amber solid, opens composer targeted at that session without leaving Home).
- All status pills use `<StatusGlyph>` from T1.

**PR title:** `feat(ui): glass home and tasks pages`

---

## T4 · `feat/glass-task-detail-diff-ship` — Task detail chrome compaction + Ship flow

**Files:** `src/pages/TaskDetail.tsx`, `src/components/DiffViewer.tsx`, `src/components/AgentTabs.tsx`.

- Header: collapse title + metadata + description into **one compact L1 bar** (12px vertical padding, 15px H1, no subtitle). Metadata bar thinner (5% white, 30px blur).
- ⌘K keycap in the header's right cluster.
- CLOSE button uses red-tinted destructive glass (`#EF44441F` fill, 1px `#EF4444AA` stroke).
- Agent tabs: active tab opaque terminal-colored, inactive ghost. Each tab carries a `<StatusGlyph>` chip with per-agent state (`● running`, `▲ waiting`, `✕ errored`) derived from Claude output parsing.
- **Ship flow** (new):
  - Green `Ship` primary button in the diff-mode header (pull-request icon + green glow) — wired to open the PR Preview sheet added in T7.
  - `2 / 4 reviewed` progress chip in the diff pane header.
  - Active file in the file list gets an empty review checkbox; reviewed files show a green check + muted row.
  - `r` keybinding toggles the current file's reviewed state.
- File list on diff view grouped by directory (`DESIGN`, `SRC > COMPONENTS`, `IGNORED FILES (1)` collapsed).
- Diff pane stays opaque (terminal rule).

**PR title:** `feat(ui): glass task detail with ship flow`

---

## T5 · `refactor/composer-worktree-checkbox` — Composer flow model change

**Files:** `src/components/Composer.tsx`, `src/lib/composer-state.ts` (reducer), `src/components/fields/RepoPickerField.tsx`, `src/components/fields/BranchPickerField.tsx`.

- **Model change:** remove the explicit run-mode chip (`N / E / Ø / S`). `run_mode` is now **derived**:
  - No repo chip → `scratch`
  - Repo chip + worktree checkbox `off` → `none` (attaches to existing working tree)
  - Repo chip + worktree checkbox `on` → `new`
  - `existing` mode is accessible via a secondary menu / keyboard shortcut (no chip).
- Default state is **empty composer with a single `+ Add repo or folder` dashed-border chip**. The `S` implicit-mode hint appears on the right.
- On repo pick: default branch auto-selected; branch chip opens a filterable picker (unchanged UI).
- New `worktree` checkbox chip — boolean, default off.
- Composer modal sheet uses `<GlassPanel level={3} specular>` with a scrim that shows the blurred page behind (not pure black).
- Prompt textarea is an opaque inset block nested inside the glass sheet (terminal rule).
- Primary button `Start task` (solid cyan with glow) stays; remove the derived-mode label display.
- Update existing composer unit tests to match the new derivation logic.

**PR title:** `refactor(ui): composer worktree checkbox with implicit run mode`

---

## T6 · `feat/glass-palette-orch-settings` — Palette + Orchestrator + Settings glass pass

**Files:** `src/components/CommandPalette.tsx`, `src/pages/OrchestratorPage.tsx`, `src/pages/SettingsPage.tsx`.

- **CommandPalette:** `<GlassPanel level={3}>` over a reduced-opacity scrim (40% black + 20px blur) so content behind is visible through it. Selected row = cyan-tinted glass (same vocabulary as sidebar active). Groups: `OPEN SESSIONS` (first) then `ACTIONS`. Keycaps right-aligned. Focus ring on search input.
- **OrchestratorPage:** compact L1 header holding `// ORCHESTRATOR` eyebrow + status dot + `● RUNNING` pill + `?` help chip + routine cadence hint (`every 30m · last fired 3m ago`) + `RESTART`. Terminal stays opaque. L1 command bar at bottom with sparkles icon, placeholder, `⌘↵` keycap.
- **SettingsPage:** two-column layout — left L1 section nav (`GENERAL`, `ORCHESTRATOR`, `AGENTS`, `SKILLS`, `REPOSITORIES`, `EDITOR`, `AGENT LAUNCH`), right scrolling body. Each section becomes an `<GlassPanel level={2}>` card with a title bar and rows divided by 10% white strokes. Toggle switches = solid cyan when on. `Repositories` card gains a cyan `+ Add repo` chip in the header; row `⋯` overflow reveals on hover.
- ⌘K keycap in the top-right of all three page headers.

**PR title:** `feat(ui): glass palette, orchestrator, and settings`

---

## T7 · `feat/glass-system-states-and-new-surfaces` — lifecycle, empty states, PR sheet, parallel grid · **do last**

**Depends on T1–T6** (integrates with `TaskDetail`, `HomePage`, `CommandPalette`, and adds one new route).

- **Lifecycle states** for `TaskDetail`:
  - `setting_up` — checklist screen (worktree created, tmux started, Claude launching…, waiting for output) with amber spinner and "View logs" escape hatch.
  - `error` — red banner with task error message, full stack trace in the terminal below, footer with `View logs` + destructive `Delete task`.
  - Disconnected / stalled terminal banner — amber `cloud-off` pill over a dimmed terminal with `Reconnecting in 3s…` and `Retry now` CTA.
- **Empty states:**
  - Home first-run: hero with `Create your first task (⌘N)` primary button.
  - Inbox zero: green circle + `Inbox zero` header + friendly subtitle.
  - Palette no-results: `No matches` + `⌘N New task with '<query>'` escape hatch (creates a new task with the current query as title).
  - Tasks zero-state: a cleaner empty with the same CTA.
- **PR Preview sheet** (new route or modal): `<GlassPanel level={3}>` centered sheet. Editable PR title + pre-filled body templated from task title + diff summary. `Save draft` secondary, `Create PR` primary (green with glow). After success, transitions the task to a `closed-merged` state and shows the PR URL.
- **Parallel Agent Grid** (new view, reachable from Orchestrator or via `⌘⇧G`): 2×3 grid of compact opaque terminal panes, each with a header (branch · state pill), tail output body, and telemetry footer (`opus-4.7 · 412k/1M · $2.14 · 00:14:22`). State pills per pane: running / waiting / errored / closed — cover all four.
- **Global offline banner** (thin L1 strip, amber) surfaced when the websocket can't reconnect for >10s.
- Long-title truncation on sidebar and task-detail header (ellipsize after N chars, full title on hover/focus).

**PR title:** `feat(ui): liquid-glass system states, empty states, PR sheet, parallel grid`

---

## Blocker on dispatch

Tried dispatching via `octomux create-task` — the running server (main branch) returns `table tasks has no column named repo_path` for every create. Main appears mid-migration to the workspaces/worktrees split schema. Dispatch once that lands, via:

```bash
octomux create-task \
  --title '<title from above>' \
  --description '<1-line summary>' \
  --repo-path /Users/shreypaharia/Documents/Projects/Ostium/octomux-agents \
  --branch <branch from above> \
  --base-branch main \
  --initial-prompt "$(cat <<'EOF'
<paste the relevant T# section from this file>
EOF
)"
```

Or create each task in the dashboard UI using the task body above verbatim.
