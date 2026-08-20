/**
 * src/lib/plugin-ui.ts
 *
 * Client data layer for `ctx.ui` contributions (SHR-256). Fetches the binding
 * table from `GET /api/plugin-ui/contributions` (server/routes/plugin-ui.ts)
 * and, per binding, the fact payload it renders from
 * `GET /api/tasks/:id/facts` (server/routes/plugin-facts.ts — new in this
 * change, NOT YET mounted; see that file's module doc for the one-line
 * `server/api.ts` wiring the controller needs to add).
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
  /** Bare local fact type as the plugin declared it. */
  fact: string;
  /** Qualified — `<pluginId>:<fact>`. What `/api/tasks/:id/facts?type=` filters on. */
  factType: string;
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

function listContributions(): Promise<UiContribution[]> {
  return request<{ contributions: UiContribution[] }>('/plugin-ui/contributions').then(
    (r) => r.contributions,
  );
}

function readTaskFacts(taskId: string, type: string): Promise<PluginFact[]> {
  return request<{ facts: PluginFact[] }>(
    `/tasks/${taskId}/facts?type=${encodeURIComponent(type)}`,
  ).then((r) => r.facts);
}

/**
 * Every `ctx.ui` contribution for one slot.
 *
 * Refetches on a `plugin:ui-updated` event so a plugin mount/unmount updates
 * the UI with no page reload (ruling R7, plans/2026-08-20-plugin-runtime-p0.md).
 * That event type does not exist on `ServerEvent` yet (`packages/types/src/
 * index.ts`) — `server/plugins/lifecycle.ts` (SHR-254, not landed) is where a
 * real unmount would call `broadcast()`. `event.type` is cast to `string` so
 * this compiles today and starts working the moment that lands; until then
 * the filter simply never matches and contributions only refresh on remount.
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
 */
export function usePluginFacts(taskId: string, contribution: UiContribution) {
  const key = `plugin-facts:${taskId}:${contribution.factType}`;
  const { data, loading, error } = useResource<PluginFact[]>(
    key,
    () => readTaskFacts(taskId, contribution.factType),
    { events: (e) => e.payload.taskId === taskId },
  );
  return { facts: data ?? [], loading, error };
}
