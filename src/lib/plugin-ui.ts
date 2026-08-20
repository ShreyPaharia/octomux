/**
 * src/lib/plugin-ui.ts
 *
 * Client data layer for `ctx.ui` contributions (SHR-256). Fetches the binding
 * table from `GET /api/plugin-ui/contributions` (server/routes/plugin-ui.ts)
 * and, per binding, the fact payload it renders from
 * `GET /api/tasks/:id/facts` (server/routes/plugin-facts.ts, mounted in
 * `server/api.ts`).
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
