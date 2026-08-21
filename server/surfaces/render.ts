/**
 * server/surfaces/render.ts
 *
 * Resolves every `ctx.ui` panel binding against one surface's declared
 * renderers, loads the facts each binding needs, and renders. This is the
 * seam the whole ticket is about: a binding written before a surface existed
 * still renders on it with zero change to the plugin that wrote the binding
 * (see `portability.test.ts`).
 */
import { childLogger } from '../logger.js';
import { readFacts } from '../plugins/facts.js';
import { listUiContributions } from '../plugins/ui-registry.js';
import type { UiContribution } from '../plugins/ui-registry.js';
import { getSurface } from './registry.js';
import type { SurfaceDefinition, SurfacePanel, SurfacePrompt } from '@octomux/plugin-api';

const logger = childLogger('surfaces/render');

export interface RenderedPanel {
  pluginId: string;
  slot: string;
  title?: string;
  /** What the binding asked for. */
  as: string;
  /** What the surface actually drew. */
  renderer: string;
  text: string;
}

/** `as` when the surface declares it, else `surface.fallback ?? 'json'`. */
export function resolveRenderer(surface: SurfaceDefinition, as: string): string {
  if (surface.renderers.includes(as)) return as;
  return surface.fallback ?? 'json';
}

function requireSurface(kind: string): SurfaceDefinition {
  const surface = getSurface(kind);
  if (!surface) throw new Error(`unknown surface "${kind}"`);
  return surface;
}

/** Every ui contribution resolved for one surface, WITHOUT facts. */
export function contributionsForSurface(
  kind: string,
): Array<UiContribution & { renderer: string }> {
  const surface = requireSurface(kind);
  return listUiContributions().map((c) => ({ ...c, renderer: resolveRenderer(surface, c.as) }));
}

/**
 * Loads each contribution's facts for `taskId` and renders them into this
 * surface's transport. A panel whose `render` returns `undefined` is
 * dropped. A `render` that THROWS is caught and logged — one bad panel does
 * not blank the whole surface, same fail-soft discipline as the rest of the
 * plugin runtime.
 */
export async function panelsForSurface(kind: string, taskId: string): Promise<RenderedPanel[]> {
  const surface = requireSurface(kind);
  if (!surface.render) {
    throw new Error(`surface "${kind}" has no render — the client renders it`);
  }
  const render = surface.render;
  const contributions = contributionsForSurface(kind);
  const results: RenderedPanel[] = [];
  for (const c of contributions) {
    // SHR-275 made a contribution's `factType` optional: a collection-bound
    // panel has none. This path renders a TASK's panels out of the task's own
    // facts, so a collection-bound contribution has nothing to read here and
    // is skipped rather than rendered empty. Rendering collections on a
    // surface is a separate path and does not belong in the task loop.
    if (!c.factType) continue;
    const facts = await readFacts(taskId, { type: c.factType });
    const panel: SurfacePanel = {
      pluginId: c.pluginId,
      slot: c.slot,
      factType: c.factType,
      as: c.as,
      renderer: c.renderer,
      value: c.value,
      delta: c.delta,
      title: c.title,
      facts,
    };
    let text: string | undefined;
    try {
      text = render(panel);
    } catch (err) {
      logger.warn(
        { plugin_id: c.pluginId, surface_kind: kind, slot: c.slot, err },
        'surface render threw, skipping panel',
      );
      continue;
    }
    if (text === undefined) continue;
    results.push({
      pluginId: c.pluginId,
      slot: c.slot,
      title: c.title,
      as: c.as,
      renderer: c.renderer,
      text,
    });
  }
  return results;
}

/** Puts a question to a human on a surface. Throws on an unknown kind, and
 *  on a surface with no `prompt` — a question nobody can answer is a wedged
 *  run, not a degraded one, so it is never silently swallowed. */
export async function promptOn(kind: string, ask: SurfacePrompt): Promise<string | undefined> {
  const surface = requireSurface(kind);
  if (!surface.prompt) {
    throw new Error(`surface "${kind}" is read-only — it renders panels but cannot prompt`);
  }
  return surface.prompt(ask);
}
