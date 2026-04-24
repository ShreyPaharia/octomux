# Liquid Glass Redesign — Design Spike

This folder contains a single Pencil file, `glass-redesign.pen`, exploring how
Apple's iOS 26 / macOS Tahoe liquid-glass material language could be applied to
the octomux dashboard without sacrificing the keyboard-driven, information-
dense feel of a developer tool. It is a **mocks-only** spike.

## Frames in the file

Primary screens (1440 × 900 each):

1. **Home — Sessions Inbox** — `// INBOX` eyebrow, "Welcome back" H1, `▲ AWAITING REPLY` bucket, `ACTIVITY` bucket, floating composer dock.
2. **Tasks — Command Center** — `// TASKS` eyebrow, filter bar, task cards with status pills, primary `NEW TASK` CTA.
3. **Task Detail — Agents** — compact glass header (status pill + ⌘K + DIFF / EDITOR / CLOSE), thin metadata bar, agent tabs with per-tab state chip (`● running`, `▲ waiting`), opaque terminal pane.
4. **Task Detail — Diff** — directory-grouped file list with reviewed checkmarks, `Ship` (green) primary CTA in header, `2 / 4 reviewed` progress chip, split-view diff with red-hatched deletions and green additions.
5. **Composer — Task Creation** — L3 glass sheet over scrimmed + blurred task preview. Repo chip · branch chip · worktree checkbox · primary Start button.
6. **Command Palette (⌘K)** — L3 glass over scrim + content, fuzzy-match, sessions-first then actions, selected row uses cyan-tinted glass (same "selected" vocabulary as sidebar).
7. **Orchestrator** — conversational scheduler over opaque terminal, routine cadence in the header, L1 glass command bar with ⌘↵.
8. **Settings** — two-column L1 section nav + L2 glass cards per section (General / Repositories mocked).

Additional detail / system frames:

9. **Composer Toggle States** — three-state flow (empty → scratch · repo added worktree off · worktree on).
10. **Sidebar Variants** — expanded pill rows vs. collapsed 56px icon rail with badge-style running indicator.
11. **Ship — PR Preview** — post-ship L3 sheet with editable title, pre-filled body, Create PR / Save draft actions.
12. **Interaction States** — 3 × 5 matrix (sidebar pill / primary button / chip / palette row × default · hover · focus · pressed · disabled) + focus-ring token spec.

System-state strips (full-width banners with inline captions):

- **Lifecycle & Error States** — `◐ SETTING UP` (worktree + tmux + Claude init checklist), `✕ ERROR` (banner + stack trace + retry/view-logs/delete footer), `⚡ DISCONNECTED` (stalled terminal + reconnect banner).
- **Empty States** — Home first-run (prominent `Create your first task` CTA), Inbox zero (`Inbox zero`), ⌘K no-results (with `New task with 'xyzzy'` escape hatch).
- **Parallel Agent Grid** — 2 × 3 mini-terminal grid with per-pane status pill, tail output, and telemetry footer (`opus-4.7 · 412k/1M · $2.14 · 00:14:22`).

## Material system

| Tier   | Fill                         | Blur                        | Where                                                  |
| ------ | ---------------------------- | --------------------------- | ------------------------------------------------------ |
| **L0** | Opaque `#0A0A0B` / `#0B0C0F` | —                           | page canvas, terminal, diff pane, prompt input         |
| **L1** | 8% white                     | 40–50px backdrop            | sidebar, headers, filter bar, orchestrator command bar |
| **L2** | 12–14% white                 | 50–60px backdrop            | session / task / settings cards                        |
| **L3** | 18–23% white                 | 80px backdrop + drop shadow | composer dock, palette, PR sheet                       |

Every raised panel carries a 1px **specular top-edge highlight** (white at
18–30%) and a 1px inset stroke to define its glass edge. Ambient cyan +
purple gradient blobs sit behind every canvas so the backdrop-blur has
content to blur through.

## Key decisions

- **Opaque terminals / diff panes / prompt inputs.** Readability always beats
  decoration. Glass tints everything _around_ code, never code itself.
- **One selection vocabulary.** Cyan-tinted glass (`#3B82F61F` fill + 1px
  `#3B82F666` stroke) means "selected" everywhere — sidebar rows, active
  diff file, selected palette row, active repo chip.
- **Accent palette preserved.** Cyan `#3B82F6` (primary / selection / focus),
  green `#22C55E` (running · ship), amber `#FFB800` (awaiting reply / setting
  up), red `#EF4444` (destructive / error). Each state also carries a **glyph**
  (● ▲ ✕ ◐ ○) so colorblind users can read state.
- **Density preserved.** 17px / 32px H1, 11–12px monospace metadata, 8px
  nav-row padding. Glass provides the visual weight so typography stays
  dev-tool sized.
- **Inset-pill sidebar rows.** Rows are inset 12px from the edge with 10px
  radius — the macOS Sonoma/Tahoe idiom. Active row = cyan-tinted glass + 1px
  cyan stroke (no left accent bar).
- **Shortcuts everywhere.** `⌘K` chip in every top-level header; keycaps on
  primary buttons and filter chips; palette is grouped sessions-first.
- **Focus ring token.** `2px solid rgba(96,165,250,0.9)` @ 2px offset, on
  `:focus-visible` for every interactive element. Matrix frame 12 shows the
  default · hover · focus · pressed · disabled variants for the four most
  common controls.

## What's missing vs. a full shippable spec

- Loaded-state density variant (task list at 30+ items) — deferred.
- Full-bleed diff mode toggle (`.` to hide file tree) — deferred.
- Repository settings in Settings is representative; other sections (Agents,
  Skills, Editor, Agent Launch) follow the same L2-card pattern.

## Scope

Mocks only. No .tsx / .css / component changes. Applying these materials to
real components (Tailwind tokens, `backdrop-filter`, `<GlassHeader>` wrapper,
etc.) is a follow-up task.
