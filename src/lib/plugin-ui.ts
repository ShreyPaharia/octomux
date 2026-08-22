/**
 * src/lib/plugin-ui.ts
 *
 * Client data layer for `ctx.ui` contributions (SHR-256, collapsed onto
 * `ctx.records` in SHR-282). Fetches the binding table from
 * `GET /api/plugin-ui/contributions` (server/routes/plugin-ui.ts) and, per
 * binding, the records it renders — from
 * `GET /api/tasks/:id/records` when this component is mounted WITH a
 * `taskId` (task-scoped), or `GET /api/plugin-records/:name` when it isn't
 * (durable/unscoped) — see `server/routes/plugin-records.ts`. Which one runs
 * is decided by the CALLER's context (is there a task in scope?), never by a
 * property of the binding: SHR-282 removed the fact/collection distinction
 * from `UiContribution`, so there is nothing left on a binding to branch on.
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
  /** Bare local store name as the plugin declared it. */
  record: string;
  /** Qualified — `<pluginId>:<record>`. What both record endpoints key on. */
  recordStore: string;
  /** Renderer name. Unknown names degrade to `json` client-side — see `src/workflows/renderers`. */
  as: string;
  value?: string;
  delta?: string;
  title?: string;
}

/** One row from `GET /api/tasks/:id/records` or `GET /api/plugin-records/:name`
 *  — mirrors the server's `RecordEnvelope` (`@octomux/plugin-api`) by value,
 *  same reasoning as `UiSlot` above. */
export interface RecordEnvelope {
  seq: number;
  store: string;
  taskId: string | null;
  key: string | null;
  payload: unknown;
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

function readTaskRecords(taskId: string, store: string): Promise<RecordEnvelope[]> {
  return request<{ records: RecordEnvelope[] }>(
    `/tasks/${taskId}/records?store=${encodeURIComponent(store)}`,
  ).then((r) => r.records);
}

function queryRecordStore(store: string): Promise<RecordEnvelope[]> {
  return request<{ records: RecordEnvelope[] }>(
    `/plugin-records/${encodeURIComponent(store)}`,
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
 * The records a single contribution renders.
 *
 * With a `taskId` (mounted on a task page), reads are task-scoped
 * (`GET /api/tasks/:id/records`) and refetch on any WS event carrying that
 * taskId — task activity is what writes task-scoped records, so the existing
 * task-scoped events (`task:updated`, `task:phase_complete`, …) are
 * sufficient; no new event type needed here.
 *
 * Without one (e.g. mounted at `settings.card`), reads are the unscoped
 * store query (`GET /api/plugin-records/:name`) — durable data, no task in
 * the picture. No `ServerEvent` exists yet for a record write either
 * (`server/plugins/records.ts`'s `watchStore` is an in-process emitter for
 * server-side subscribers, not a `/ws/events` broadcast), so this branch is
 * deliberately fetch-once-per-mount — the no-`events` case `use-resource.ts`
 * documents as intentional for "resources with no live updates".
 */
export function usePluginRecords(contribution: UiContribution, taskId?: string) {
  const store = contribution.recordStore;
  const key = taskId ? `plugin-task-records:${taskId}:${store}` : `plugin-record-store:${store}`;
  const { data, loading, error } = useResource<RecordEnvelope[]>(
    key,
    () => (taskId ? readTaskRecords(taskId, store) : queryRecordStore(store)),
    taskId ? { events: (e) => e.payload.taskId === taskId } : undefined,
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
