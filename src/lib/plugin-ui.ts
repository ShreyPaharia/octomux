/**
 * src/lib/plugin-ui.ts
 *
 * Client data layer for `ctx.ui` contributions (SHR-256, extended for
 * collections in SHR-275). Fetches the binding table from
 * `GET /api/plugin-ui/contributions` (server/routes/plugin-ui.ts) and, per
 * binding, the data it renders — either fact-bound
 * (`GET /api/tasks/:id/facts`, server/routes/plugin-facts.ts) or
 * collection-bound (`GET /api/plugin-collections/:name`,
 * server/routes/plugin-collections.ts).
 *
 * A contribution is bound to exactly ONE of `fact`/`factType` (task-scoped,
 * dies with the task) or `collection`/`collectionName` (durable, no task in
 * the binding at all) — never both. Both pairs are optional on the wire type
 * for that reason; callers branch on which pair is present.
 *
 * Extended for SHR-257 (`ctx.ui.action()`): `GET /api/plugin-ui/actions` and
 * `POST /api/plugin-ui/actions/:actionId` are read-only/write-only mirrors of
 * the same idea — a plugin declares an action, the host runs the handler,
 * only data (never plugin code) reaches this module.
 *
 * Follows the same `useResource` shape as everything else in
 * `src/lib/hooks.ts` — no hand-rolled fetch/state pattern. `request` is
 * imported straight from `./api/client` rather than adding a new namespace to
 * `src/lib/api/` — there's nothing there to reuse for a two-endpoint surface.
 *
 * `UiSlot`/`UiRenderer` mirror `@octomux/plugin-api` (packages/plugin-api/src/
 * index.ts) by value rather than by import: that package isn't a dependency
 * of the root (frontend) workspace, and adding one for two string unions
 * isn't worth it. Keep these in sync with the plugin-api source if it changes.
 */
import { useMemo } from 'react';
import { request } from './api/client';
import { useResource } from './use-resource';

export type UiSlot =
  | 'task.panel'
  | 'task.badge'
  | 'board.card'
  | 'nav.section'
  | 'run.detail'
  | 'settings.card';

export interface UiContribution {
  pluginId: string;
  slot: UiSlot;
  /** Bare local fact type as the plugin declared it. Present iff `factType` is
   *  — a fact-bound contribution. */
  fact?: string;
  /** Qualified — `<pluginId>:<fact>`. What `/api/tasks/:id/facts?type=` filters on. */
  factType?: string;
  /** Bare local collection name as the plugin declared it. Present iff
   *  `collectionName` is — a collection-bound contribution. */
  collection?: string;
  /** Qualified — `<pluginId>:<collection>`. What `/api/plugin-collections/:name` reads. */
  collectionName?: string;
  /** Renderer name. Unknown names degrade to `json` client-side — see `src/workflows/renderers`. */
  as: string;
  value?: string;
  delta?: string;
  title?: string;
}

export interface PluginFact {
  seq: number;
  taskId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

/** One row from `GET /api/plugin-collections/:name` — mirrors the server
 *  contract in server/routes/plugin-collections.ts by value (same reasoning
 *  as `UiSlot` above: not worth a runtime dependency on `@octomux/plugin-api`
 *  for one shape). */
export interface CollectionRecord {
  /** Qualified collection name. */
  collection: string;
  key: string;
  /** The plugin's record — shape is whatever it defined, opaque here. */
  record: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * An action as served to the client — the declaration with its handler
 * stripped and its id qualified (`@octomux/plugin-api`'s
 * `UiActionContribution`, mirrored by value for the same reason `UiSlot` is
 * above). `actionId` is the address `POST /api/plugin-ui/actions/:actionId`
 * takes; `slot` absent means command-palette only (no button anywhere else).
 */
export interface UiAction {
  pluginId: string;
  actionId: string;
  id: string;
  label: string;
  slot?: UiSlot;
  schema?: Record<string, unknown>;
  command?: boolean;
  confirm?: string;
}

function listContributions(): Promise<UiContribution[]> {
  return request<{ contributions: UiContribution[] }>('/plugin-ui/contributions').then(
    (r) => r.contributions,
  );
}

function listActions(): Promise<UiAction[]> {
  return request<{ actions: UiAction[] }>('/plugin-ui/actions').then((r) => r.actions);
}

function readTaskFacts(taskId: string, type: string): Promise<PluginFact[]> {
  return request<{ facts: PluginFact[] }>(
    `/tasks/${taskId}/facts?type=${encodeURIComponent(type)}`,
  ).then((r) => r.facts);
}

function readCollection(qualifiedName: string): Promise<CollectionRecord[]> {
  return request<{ records: CollectionRecord[] }>(
    `/plugin-collections/${encodeURIComponent(qualifiedName)}`,
  ).then((r) => r.records);
}

/**
 * Every `ctx.ui` contribution for one slot.
 *
 * Refetches on a `plugin:ui-updated` event so a plugin mount/unmount updates
 * the UI with no page reload (ruling R7, plans/2026-08-20-plugin-runtime-p0.md).
 * The event type is declared on `ServerEvent` (`packages/types/src/index.ts`)
 * and broadcast from `server/plugins/lifecycle.ts` and `server/plugins/loader.ts`
 * (SHR-254, landed). `event.type` is still cast to `string` here only because
 * this module doesn't otherwise import `ServerEvent`, not because the type is
 * missing.
 */
export function usePluginUiContributions(slot: UiSlot) {
  const { data, loading, error } = useResource<UiContribution[]>(
    'plugin-ui-contributions',
    listContributions,
    { events: (e) => (e.type as string) === 'plugin:ui-updated' },
  );
  const contributions = useMemo(() => (data ?? []).filter((c) => c.slot === slot), [data, slot]);
  return { contributions, loading, error };
}

/**
 * The facts a single contribution renders, scoped to one task. Refetches on
 * any WS event carrying that taskId — task activity is exactly what writes
 * facts, so the existing task-scoped events (`task:updated`,
 * `task:phase_complete`, …) are sufficient; no new event type needed here.
 *
 * `contribution.factType` is optional on the wire type now (a
 * collection-bound contribution has none) — a missing `factType` disables
 * the fetch via `key: null` rather than erroring, so `PluginPanel` can call
 * this hook unconditionally for every contribution (rules of hooks) and let
 * the binding decide which of `usePluginFacts`/`usePluginCollection` actually
 * fetches.
 */
export function usePluginFacts(taskId: string, contribution: UiContribution) {
  const factType = contribution.factType;
  const key = factType ? `plugin-facts:${taskId}:${factType}` : null;
  const { data, loading, error } = useResource<PluginFact[]>(
    key,
    () => readTaskFacts(taskId, factType as string),
    { events: (e) => e.payload.taskId === taskId },
  );
  return { facts: data ?? [], loading, error };
}

/**
 * The records a single collection-bound contribution renders. Collections
 * are NOT task-scoped (server contract, SHR-275) so there is no task-id
 * predicate to refetch on the way `usePluginFacts` has one — `e.payload.taskId
 * === taskId` has no equivalent here.
 *
 * No `ServerEvent` exists yet for a collection write either:
 * `server/plugins/collections.ts`'s `watchCollection` is an in-process
 * emitter for server-side subscribers, not a `/ws/events` broadcast. So this
 * resource is deliberately fetch-once-per-mount — exactly the no-`events`
 * case `use-resource.ts` documents as intentional for "resources with no
 * live updates". Add an `events` predicate here once a
 * `plugin:collection-updated` (or similar) `ServerEvent` ships.
 *
 * Same optional-binding guard as `usePluginFacts`: a fact-bound contribution
 * has no `collectionName`, so `key` is `null` and this hook is a no-op for it.
 */
export function usePluginCollection(contribution: UiContribution) {
  const collectionName = contribution.collectionName;
  const key = collectionName ? `plugin-collection:${collectionName}` : null;
  const { data, loading, error } = useResource<CollectionRecord[]>(key, () =>
    readCollection(collectionName as string),
  );
  return { records: data ?? [], loading, error };
}

/**
 * Every `ctx.ui.action()` contribution, optionally filtered to one slot.
 * Called with no `slot` (the command palette's case) returns every action —
 * a palette entry isn't tied to a rendering slot.
 *
 * Refetches on the same `plugin:ui-updated` event `usePluginUiContributions`
 * does, for the same reason: an action is part of a plugin's mount/unmount
 * lifecycle (`server/plugins/lifecycle.ts` / `loader.ts` broadcast that event
 * for both panels and actions), so a plugin that unmounts must make its
 * buttons and palette rows disappear with no page reload, not just its panels.
 */
export function usePluginUiActions(slot?: UiSlot) {
  const { data, loading, error } = useResource<UiAction[]>('plugin-ui-actions', listActions, {
    events: (e) => (e.type as string) === 'plugin:ui-updated',
  });
  const actions = useMemo(
    () => (data ?? []).filter((a) => (slot === undefined ? true : a.slot === slot)),
    [data, slot],
  );
  return { actions, loading, error };
}

/**
 * Invokes a plugin action by its qualified id. The handler runs entirely in
 * the host (`server/plugins/ui-actions.ts` or wherever the server half
 * lands) — this is a bare POST, never plugin code reaching the browser.
 * `taskId` is omitted for task-free invocations (e.g. the command palette).
 */
export function invokePluginAction(
  actionId: string,
  body: { taskId?: string; input?: Record<string, unknown> },
): Promise<{ ok: boolean; message?: string }> {
  return request<{ ok: boolean; message?: string }>(
    `/plugin-ui/actions/${encodeURIComponent(actionId)}`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}
