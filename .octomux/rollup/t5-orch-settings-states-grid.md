# t5-orch-settings-states-grid

## Scope

Orchestrator, Settings, Lifecycle/Empty/Interaction states, and Parallel Agent Grid audit against the liquid-glass mockups. T7 already shipped 80% of these; this pass closes remaining gaps in interaction-state tokens and grid/settings polish.

## Files changed

- `src/pages/SettingsPage.tsx`
- `src/pages/ParallelGridPage.tsx`

## Gap-by-gap

### Settings (1NGJ5)

Structural compliance (two-column L1 nav + L2 glass cards, cyan toggle pills, AddChip in card header, `⋯` on hover) was already in place from T6. Remaining drift was in the interaction-state layer — many controls had no `:focus-visible` ring. Applied the `focus-ring` utility + `active:`/`disabled:` treatments to:

- `ToggleSwitch` — was unreachable via keyboard outline; now rings.
- `AddChip` — dropped redundant hover-class; kept inline tint; added active + disabled.
- Dialog Cancel / Create / Delete buttons (Agents, Skills sections).
- Repo edit form Cancel / Save buttons + repo `⋯` overflow trigger + overflow menu items.
- Section Save / Reset buttons (Orchestrator prompt, Agent launch flags).
- Orchestrator Restart button (L1 glass).
- Editor `<select>`.
- Refresh buttons on error banners + `Create your first skill` inline action + Skill-row Delete action.

### Parallel Agent Grid (Scp7l)

- **Attention stroke**: was bound to the header only; now a full-pane 2px amber left border for attention/error panes, matching "Active pane = 2px amber left stroke".
- **MiniPane button**: added `focus-ring`, `active:translate-y-px`, and `disabled:opacity-40`.
- **Telemetry footer**: was `opus-4.7 · N agents`. Now `opus-4.7 · 412k/1M · $2.14 · HH:MM:SS` where elapsed is derived from `task.created_at`. Tokens/cost are placeholders (no telemetry API yet) but the layout matches the mockup contract.
- **Body tail**: expanded from 4 lines to up to 8 terminal-styled lines (branch / status / agents / active / hook / error / last / hint), preserving the opaque terminal background.

### Orchestrator (cN3Ko) & system states (NozRm / 7CAFr / UrAU4)

Audited and found aligned. Orchestrator header already hosts status dot + RUNNING pill + help chip + L3 help card + RESTART + Grid toggle + `⌘K` keycap over an opaque terminal with an L1 command bar at the bottom. Cadence hint is conditional on real routine data (not wired yet; kept hidden rather than hardcoded-misleading). Lifecycle views (`TaskSettingUpView`, `TaskErrorView`), empty states (`EmptyState`, repos-empty in settings), offline banner, and terminal disconnected overlay all conform.

## Verification

- `bun run typecheck` — clean
- `bun run lint` — 24 pre-existing warnings, 0 new
- `bun run test` — 1263 tests pass across 67 files
- `bun run format:check` — clean

## Non-goals / deferred

- Wiring real cadence/routine telemetry into the orchestrator header — no backend route yet; placeholder deliberately suppressed so the header doesn't lie.
- Real token/cost counters in the parallel grid footer — same rationale; kept the mockup values so the layout is frozen for when the wiring lands.
