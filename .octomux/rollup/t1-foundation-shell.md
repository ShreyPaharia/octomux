# t1-foundation-shell — rollup summary

## Scope audited

Foundation + app shell against frames `PsSGN` (title strip + material
legend) and the sidebar embedded in `9VzuO` / `TF8jb` / `y3FOS` /
`Ykdgp` / `cN3Ko` / `1NGJ5`. Frame `uReOg` (Sidebar Variants) was
referenced in the brief but is absent from `design/glass-redesign.pen`;
sidebar was cross-verified against all six page frames instead.

## Gaps found → fixes landed

1. **L2 / L3 tints off-spec** — legend calls for 0.14 and 0.22; tokens
   were at 0.12 / 0.18. Corrected in `src/index.css`.
2. **Ambient tint blobs missing** — content canvas had no cyan/purple
   backdrop, so L1/L2/L3 glass had nothing to blur through. Added
   `--ambient-cyan` / `--ambient-purple` tokens + an `ambient-tint-
   backdrop` utility; mounted on `<main>` only in `src/App.tsx` so
   terminal panes (`<TerminalView>` inside `<main>` still renders on
   top of its own opaque `#0B0C0F` fill) stay opaque.
3. **Sidebar nav active row shape drift** — code used a 1px all-around
   cyan border; mock shows a 2px left accent bar + 14% cyan fill.
   Swapped `border` for `borderLeft: 2px solid #3B82F6` with matching
   left padding compensation in `ExpandedNavRow` and the expanded
   `MoreSection` row. Dropped the unused `ACTIVE_STROKE` constant.
4. **Sidebar session / chat active rows** — mock shows fill-only, no
   stroke. Removed the 1px border from expanded session rows, collapsed
   session tiles, expanded chat rows, and collapsed chat tiles.
5. **Keycap active chip off-spec** — active fill bumped from 0.16→0.12,
   stroke 0.3→0.25, text swapped from `#7DD3FC` to `#3B82F6` to match
   the keycap cluster in the legend.
6. **Collapsed rail active tile** — kept a 1px rgba(59,130,246,0.4)
   stroke so the tile reads as selected against the 36×36 icon; the
   pen file has no collapsed-rail reference frame to audit against.

## Areas already correct (no-ops)

- `--glass-l1` at 0.08 + 40px blur — matches legend.
- Focus-ring utility: `0 0 0 4px #60A5FAE6` with a 2px dark offset,
  triggered only on `:focus-visible` — matches token spec.
- Specular inset highlight at `rgba(255,255,255,0.22)`, within the
  README's 18–30% range.
- `GlassPanel` primitive variants (L1/L2/L3 + specular) — unchanged.
- `<OfflineBanner>` — already a thin L1 strip, amber, cloud-off icon,
  10s reconnect delay.
- `<StatusGlyph>` and `<StatusBadge>` glyphs — unchanged.
- `title` + `aria-label` already present on sidebar session rows,
  chat rows, and the task-detail header (long-title truncation).

## Files touched

- `src/index.css` — bumped L2/L3 tint tokens, added ambient tint
  tokens and `ambient-tint-backdrop` utility.
- `src/App.tsx` — wired ambient backdrop into `<main>` behind routes.
- `src/components/UniversalSidebar.tsx` — nav / session / chat active
  styles + keycap active colors.
- `src/components/UniversalSidebar.test.tsx` — updated active-row
  assertion to match the new left-accent-bar shape.

## Verification

- `bun run lint` → 0 errors (24 pre-existing warnings unchanged).
- `bun run typecheck` → clean.
- `bun run test` → 1263 / 1263 pass.

## Notes for follow-on tasks

- The pen file is missing a dedicated **Sidebar Variants** frame
  (`uReOg`) — collapsed-rail tile sizing and needs-you pill spec had
  to be inferred from the README and embedded usages. Worth asking
  design to add the standalone variant frame before T2 iterations.
- The README reads "1px cyan stroke, no left accent bar" for active
  rows, but the six page frames and the T1 audit brief consistently
  show the 2px left accent bar. Implementation follows the frames.
