/**
 * `ctx.ui` contributions — declarative bindings, never components.
 *
 * A plugin gets exactly two rendered things today: a schedules form from
 * `config` and a run detail view from `output`, on three fixed surfaces. There
 * is no sidebar, no panel, no badge — not because rendering is hard, but
 * because there was no shared data for a panel to render. `ctx.facts` supplies
 * that; this supplies the binding.
 *
 * No plugin JavaScript ever reaches the browser. The client owns every
 * renderer and looks it up by name; the server only ever serves this table as
 * JSON. There is no `ctx.ui.component()`.
 *
 * SIGNATURES ARE PINNED (plans/2026-08-20-plugin-runtime-p0.md STEP-0).
 * Task D fills in the bodies; nothing here may change shape.
 */
import type { UiPanelBinding } from '@octomux/plugin-api';

const notImplemented = (what: string): never => {
  throw new Error(`${what}: not implemented — SHR-256 (task D) owns this module`);
};

/** A binding as served to the client: the plugin's declaration with its fact
 *  type qualified and its owner attached. */
export interface UiContribution extends UiPanelBinding {
  /** Manifest row id of the contributing plugin. */
  pluginId: string;
  /** Qualified fact type — `<pluginId>:<fact>`. */
  factType: string;
}

/** Registers a panel binding. `binding.fact` is BARE; this qualifies it. */
export function registerPluginUiPanel(_pluginId: string, _binding: UiPanelBinding): void {
  notImplemented('registerPluginUiPanel');
}

/**
 * Every contribution, for `GET /api/plugin-ui/contributions`.
 *
 * STEP-0 ships the empty-table behaviour rather than a throwing stub — the
 * route is mounted at boot and a throw here would 500 the SPA before task D
 * lands. Task D replaces the body.
 */
export function listUiContributions(): UiContribution[] {
  return [];
}

/** Drops a plugin's contributions. Called on unmount — the panel must vanish
 *  with no restart. Safe to call for a plugin that registered none. */
export function unregisterPluginUi(_pluginId: string): void {
  notImplemented('unregisterPluginUi');
}

/** Test-only: clears all contributions. */
export function resetPluginUi(): void {
  notImplemented('resetPluginUi');
}
