# T4 · Composer + Command Palette glass audit

Frames audited: `zqZ33` (Composer sheet) · `ldkwq` (Composer toggle states) ·
`CsQvc` (Command Palette).

## Composer (src/components/Composer.tsx)

- Verified no run-mode chip present (PR #110 cleanup held up).
- Verified `⌘R / ⌘B / ⌘W` shortcut wiring remains intact.
- Repo chip (filled state) rebuilt as cyan-tinted glass pill:
  12% cyan fill + 40% cyan stroke + cyan text, matching the shared
  "selected" vocabulary used by sidebar active rows and palette selection.
- Repo, branch, attach, draft, and scratch-hint chips are now `rounded-full`
  pills; empty-state repo chip keeps its dashed stroke.
- `BranchChip` wraps the picker in a pill. `BranchPickerField` gained an
  optional `triggerClassName` prop so the trigger can blend into the chip
  (DraftEditForm / CommandFieldForm fall back to the default trigger style).
- Worktree checkbox renamed visually to "new worktree" (aria-label
  unchanged); active state tightened to match the cyan selection token and
  moved to `rounded-lg`.
- Textarea + footer row now live inside a single opaque `#0B0C0F` block —
  the terminal-rule prompt inset shown in the mockup. A
  `⌘↵ start · ⇧↵ new line` keycap hint sits next to the Start button.
- Added `focus-ring` utility to chips, textarea, and pickers.

## Command Palette (src/components/CommandPalette.tsx)

- Scrim backdrop bumped to **48% black + 20px blur** (was 40%) — the
  double-blur "app pauses" feel from annotation BQQtM.
- Panel: `rounded-2xl overflow-hidden` so the glass has a crisp edge; search
  row no longer uses an opaque backing, it reads through the glass.
- `Keycap` primitive now `rounded-md` with 1px edge stroke + inset specular.
- `GroupHeader` accepts a count chip (`OPEN SESSIONS 3`) per mockup.
- Result rows `rounded-lg` so the cyan selection wash has soft corners.

## Not changed

- Composer is still mounted inline in HomePage rather than as an L3 modal
  sheet; restructuring to a sheet is out of scope for this audit (keeping
  the Composer tests + URL hydration contract untouched).
- `GlassPanel` / status-glyph primitives are unchanged — no new glass
  primitives introduced.

## Verification

- `bun run typecheck` — clean.
- `bun run lint` — 0 errors (pre-existing warnings unchanged).
- `bun run test` — 1263/1263 passing.
