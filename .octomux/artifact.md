# SHR-275 — `ctx.collections`

Commit `16b7846`. `bun run typecheck` / `format:check` / `lint` clean; full
suite green (3663 + 1301 + 223, 0 fail).

## What shipped

- **`plugin_collections` table** — PK `(collection, key)`, `record` JSON text,
  `created_at` / `updated_at`. Its **own** table, not `plugin_facts` with a
  nullable `task_id`: ruling R1's reasoning is that two concerns with different
  lifetimes do not share one table and one sequence. There is deliberately **no**
  delete-on-task-delete sweep — rows are durable, that is the whole API.
- **`ctx.collections`** (`server/plugins/collections.ts`) — `define` / `put` /
  `query` / `watch`, mirroring `facts.ts` almost line for line. Names qualify to
  `<pluginId>:<name>`; a `core:` name is refused. `put` takes a **bare** name only
  (cross-plugin writes are out of scope and rejected with a message saying so);
  `query` takes bare **or** qualified and is unscoped, matching `facts.read`.
  The key must be a top-level `string` or finite `number`.
- **`QuerySpec`** — exact-match `where` via `json_extract` (field names validated
  against `^[A-Za-z_][A-Za-z0-9_]*$` before they reach SQL), `orderBy` /`order`
  (whitelisted to `ASC`/`DESC`), `limit` / `offset` bound as parameters. No
  operator language, no joins, no aggregates.
- **Capabilities** `collections.define` and `collections.write`, added in **both**
  `PLUGIN_CAPABILITIES` and the `PluginCapability` union. Reads are ungated, like
  `facts.read` / `artifacts.list`. The manifest validator rejects a typo such as
  `collections.put`.
- **`ctx.ui` unstranded** — `UiPanelBinding` is now
  `UiFactPanelBinding | UiCollectionPanelBinding`. Every already-merged fact-bound
  binding is unchanged and still tested. `ui-registry.ts` enforces exactly-one-of
  and qualifies into `factType` | `collectionName`; `context.ts` stopped requiring
  `fact` so one place owns the rule. `GET /api/plugin-collections/:name` serves
  records; the client adapts them into the existing renderer shape, so all eight
  renderers work on collections with zero renderer change.
- **Unmount** — `unregisterPluginCollections` drops **definitions only, never
  rows**, wired into `lifecycle.ts` between `facts` and `ui`, reported as
  `released.collectionNames`, surfaced in the catalog as `collection:<qualified>`.
  A dedicated test asserts a record written before unmount is still readable
  after: that is the guarantee a future refactor would break.

## Left out, deliberately

Cross-plugin writes; schema migration of a defined collection; Postgres (SHR-270,
cancelled). SHR-263 / `ctx.kv` was **not** absorbed — it still throws.

## What I want challenged

1. **No WS invalidation for collection writes.** `usePluginCollection` is
   fetch-once-per-mount; `watchCollection` is in-process only and no `ServerEvent`
   broadcasts a collection write. A durable panel therefore does not live-update.
   I judged inventing `plugin:collection-updated` out of scope, but it is the
   obvious follow-up and it makes the "unstranded" claim weaker than it sounds.
2. **`PluginPanels` still requires a `taskId` prop** even for a collection-bound
   panel, which needs none. Fine for `task.panel`; wrong-shaped for `nav.section`
   / `settings.card`, which is exactly where durable panels want to live.
3. **Records are adapted into the `PluginFact` shape client-side** (`seq` = index,
   `createdAt` = `updatedAt`). Zero renderer churn, but it is a shim — with a
   second consumer the renderer prop should be renamed to something
   binding-agnostic.
4. **`QuerySpec` has no operators and no paging cursor.** Deliberate, but it is
   public API shape — say so now if you disagree.
5. **Pre-existing sharp edge**, hit while writing tests: the ajv cache in
   `output-contract.ts` is keyed on the qualified name alone, so reusing a
   collection name with a different schema silently validates against whichever
   compiled first. Facts already live with this; not changed here.
6. **Worktree hazard**: this worktree had no `node_modules`, so
   `@octomux/plugin-api` resolved to the **main checkout's** stale `dist` and
   `typecheck` lied (green on code that could not compile). `bun install` in the
   worktree fixed it. Any worktree task touching `packages/*` will hit this.
