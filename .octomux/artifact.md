# SHR-279 — collection-bound panels render somewhere

`bun run typecheck` / `format:check` / `lint` clean; full suite green
(3767 + 1305 + 223, 0 fail).

## The bug

SHR-275 made `UiPanelBinding` a union so a panel could bind to a durable
collection instead of a task-scoped fact. SHR-267 landed in parallel against
the old shape, walks a TASK, and reads `readFacts(taskId, { type: c.factType })`.
The merge conflict was resolved with `if (!c.factType) continue;` — correct for
the task path, but it left collection-bound panels drawn by nothing.

## What shipped

- **`server/surfaces/render.ts`** — `renderCollectionPanels(kind, collectionName, q?)`,
  a second entry point beside `panelsForSurface`, never folded into the task loop.
  Reads records once via `queryRecords` (unscoped, like `facts.read`); `q` windows
  a large collection. Same fail-soft discipline: a `render` that throws is logged
  and skipped, `undefined` is dropped.
- **Records arrive as `Fact[]`.** A local `recordsAsFacts` mirrors the one the
  client already shipped in `src/components/PluginPanels.tsx`. That is what makes
  the portability property hold for both binding kinds: a surface's `render`
  never branches on which kind of binding it is drawing, so a `render` written
  before collections existed draws a collection panel with zero change.
- **`packages/plugin-api`** — `SurfacePanel.factType` optional, `collectionName?`
  added, `facts` documented as "either kind".
- **Slot: `settings.card`, no new `UiSlot`.** Of the two non-task-scoped slots,
  `nav.section` would need a route and a page invented; `settings.card` already
  has a page. `<PluginPanels slot="settings.card" />` mounts on SettingsPage with
  `taskId` now optional — in task-free mode it renders only collection-bound
  contributions, exactly mirroring the server's split.
- **`GET /api/plugin-collections/:name/panels?surface=…`** — without it the new
  function had no caller outside the process, which is the same bug again.
  `web` 400s here by design (no `render`; the browser draws it).
- **`table` renders one row per record.** `tableRows` only ever read the LATEST
  payload, so a collection rendered as `—`. Now it falls back to one row per
  entry — fixed identically in `server/surfaces/text.ts` and
  `src/workflows/renderers/index.tsx`, which are deliberate mirrors. For a
  fact-bound panel this only fires where the old code rendered nothing.
- **`server/surfaces/portability.test.ts`** — the pinned property now holds for
  both binding kinds: pipeline-bot binds a collection, `demo:discord` is
  registered afterwards by a plugin with zero collection-aware code, and the
  panel renders on it degraded to Discord's fallback.

## Not done

- No CLAUDE.md / `docs/plugins` update — SHR-274 owns that pass and is running
  concurrently; a doc edit here would just collide.
- `octomux task rename` doesn't exist in the installed CLI and `PATCH /api/tasks/:id`
  refuses a non-draft task, so the task keeps its ticket title.
- `nav.section` still hosts nothing. A collection panel declared there renders
  nowhere on web. Worth challenging: it may want a generic `/plugins` page.
- `RenderedPanel` doesn't carry `collectionName`. Callers get `pluginId`/`slot`;
  add it if a surface ever needs to group by collection.
