# T2 · Home + Tasks glass audit

Scope: Sessions Inbox (Home) + Command Center (Tasks) aligned against
pen frames `9VzuO` (Home) + `TF8jb` (Tasks).

## Gaps closed

- **SessionsInbox restructure.** Dropped the outer L2 `GlassPanel`
  wrapper that flattened every row into one card. Per the mockup:
  - `Awaiting reply` cards are now per-item L2 glass (16px radius,
    inset specular top-edge + `0 12px 30px -8px` shadow) with an
    **amber** `#FFB80040` tinted border.
  - `Errored` cards use the same L2 treatment with a **red**
    `#EF444440` border.
  - `Activity` rows are L1 glass (12px radius, lighter stroke),
    separated from the Awaiting/Errored group by a thin rule + the
    `// ACTIVITY` all-caps mono eyebrow.
- **TaskCard end-pill.** `StatusBadge` now takes a `variant` prop;
  the task card uses `variant="pill"` so status reads as a tinted
  pill (running=green, needs-you/setting-up=amber, closed=grey,
  error=red) with inner 1px stroke — matching the right-side end-pill
  in the Tasks mockup.
- **TaskFilterBar.** Added explicit `rounded-[14px]` to match the
  unified L1 filter-bar panel and inserted a thin inline separator
  between the status chips and the repo dropdown (replaces the
  implicit gap with the `fbSep` rule in the pen).
- **Composer dock.** Home now renders the Composer as a floating
  L3 dock: absolute-positioned at `bottom-6`, centered, `w-[90%]
max-w-[1056px]`, with a drop-shadow filter for lift. Scroll body
  gets `pb-[280px]` so inbox content no longer slides under the
  dock. Composer itself now has an explicit `rounded-[20px]` outer
  radius to match the pen.

## Verification

- `bun run typecheck` — clean
- `bun run lint` — no new errors (24 pre-existing warnings unchanged)
- `bun run test` — 1263/1263 passing

## Files touched

- `src/components/SessionsInbox.tsx`
- `src/components/StatusBadge.tsx`
- `src/components/TaskCard.tsx`
- `src/components/TaskFilterBar.tsx`
- `src/components/Composer.tsx`
- `src/pages/HomePage.tsx`
