# T3 Task Detail / Diff / PR Sheet — Glass Audit

Scope: Task Detail (Agents view + Diff view + Ship flow) and the PR Preview sheet.
Slug: `t3-task-detail`.
Branch: `agents/glass-audit-t3-task-detail-diff-pr-sheet-3PULJT` → rolled up to `feat/glass-redesign`.

## Frames audited

- **y3FOS + MifSX** — Task Detail / Agents
- **Ykdgp + OXzCy** — Task Detail / Diff
- **h3PJl** — Ship / PR Preview sheet (frame id not present in the pen; used the annotation spec supplied in the task prompt)

## Gaps found and fixed

1. **Task detail header typography.** Title was `text-[15px]` and header padding was `py-3 px-4`. Mockup specifies a 17px title on an L1 bar with 18px/24px padding. → bumped to `text-[17px]` + `tracking-tight` and `px-6 py-[18px]`.
2. **DIFF toggle active state.** Was a muted outline with just cyan text; mockup calls for "pressed cyan glass" (the same selection vocabulary used in sidebar/palette). → active state is now `border-[#3B82F666] bg-[#3B82F61F] text-[#3B82F6]` with cyan hover.
3. **Metadata bar stroke.** Used `border-glass-edge` (14% white) — heavier than the mockup's thin L1 feel. → switched to an inline 6% white bottom stroke; padding nudged to 10px so it reads thinner.
4. **Diff file list chrome.** The sidebar was `border-r border-border` (flat panel). Mockup specifies a 260px L1 glass panel (8% white + 40px blur + 14% stroke + inset padding). → wrapped the aside in `bg-glass-l1 glass-blur-l1 border border-glass-edge`, dropped to 260px wide, and gave the file tree 4px inset padding so rows breathe like in the mockup.
5. **Selected file row vocabulary.** Was `bg-accent` (`#141414`). Mockup reuses the cyan-tinted selection material used by the sidebar / palette / active diff toggle. → active row is now `border-[#3B82F666] bg-[#3B82F61F] text-[#3B82F6]` (with a transparent border on inactive rows so layout stays stable).
6. **Diff pane material.** Plain border and no shadow previously. → now has a 14% white stroke, `#101217` L1-tinted header bar (with `#FFFFFF0F` bottom stroke), and a subtle `0 8px 24px -6px rgba(0,0,0,0.5)` drop-shadow so it reads as a separate opaque pane sitting on top of the ambient canvas. Monospace filename in the header switched to `#B5B5BD`.
7. **Collapsible top-level directory groups.** `IGNORED FILES` was already collapsible but `DESIGN` / `SRC` group headers were static divs. Mockup shows all top-level directory buckets collapsing independently — one interaction vocabulary across the file list. → `TreeRow` now accepts `collapsible` + `openGroups` + `onToggleGroup`; default open; state persisted to localStorage under `octomux:diff-group-open:<taskId>:<path>`. Existing `diff-group-*` test IDs preserved.
8. **PR sheet scrim opacity.** Was `rgba(0,0,0,0.44)`; spec calls for 48% black. → bumped to `0.48`.

## Left alone (already matches mockup)

- CLOSE button is already red-tinted glass (`#EF4444AA` stroke / `#EF44441F` fill).
- Agent tabs: active tab already opaque `#0B0C0F` with cyan stroke, inactive ghost — matches mockup.
- Terminal pane is already opaque `#0B0C0F`, never blurred.
- PR sheet body structure (opaque `#0B0C0F` inset inputs, L3 sheet with specular edge, green Create PR with cyan ship chip, footer keycap hint) already matches the spec — only the scrim needed adjusting.

## Checks

- `bun run typecheck` — clean.
- `bun run lint` — clean (24 pre-existing warnings untouched; no new ones).
- `bun run test` — **1263/1263 passing**.

## Files touched

- `src/pages/TaskDetail.tsx`
- `src/components/DiffViewer.tsx`
- `src/components/DiffFileTree.tsx`
- `src/components/PrSheet.tsx`

No new primitives introduced; reused existing `bg-glass-l*` tokens, `glass-blur-l*` utilities, `glass-edge` border token, and the `#3B82F61F / #3B82F666` cyan-tinted glass pair already used across the codebase.
