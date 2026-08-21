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
import { queryRecords } from '../repositories/plugin-collections.js';
import type { CollectionRecord, QuerySpec } from '../repositories/plugin-collections.js';
import type { Fact, SurfaceDefinition, SurfacePanel, SurfacePrompt } from '@octomux/plugin-api';

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
    // is skipped rather than rendered empty. `renderCollectionPanels` below
    // (SHR-279) is the path that handles those bindings — deliberately a
    // separate function, not folded into this task loop.
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

/** Adapts collection records into `Fact[]`, mirroring `recordsAsFacts` in
 *  `src/components/PluginPanels.tsx` exactly, so a collection panel reads
 *  the same whether the browser or a server surface draws it. `seq` is the
 *  record's position in this response (a collection has no fact sequence),
 *  `taskId` is empty (a collection is task-independent), `type` is the
 *  qualified collection name, and `createdAt` reads the record's
 *  `updatedAt` — a renderer's "when" column should reflect the last write,
 *  not the original insert. */
function recordsAsFacts(records: CollectionRecord[]): Fact[] {
  return records.map((r, i) => ({
    seq: i,
    taskId: '',
    type: r.collection,
    payload: r.record,
    createdAt: r.updatedAt,
  }));
}

/**
 * Renders every panel bound to one durable collection on one surface —
 * the collection-bound counterpart to `panelsForSurface`, which only ever
 * walks a task's facts. `collectionName` must already be QUALIFIED
 * (`<pluginId>:<collection>`, what `UiContribution.collectionName` holds) —
 * there is no plugin identity at this call site to qualify a bare name
 * against.
 *
 * Same preamble as `panelsForSurface`: throws on an unknown surface, and
 * throws the same "the client renders it" error when `surface.render` is
 * absent — that is how the `web` surface DECLARES IT CANNOT render
 * server-side, and this path keeps that behaviour rather than working
 * around it.
 *
 * Records are read ONCE via `queryRecords` (unscoped, like `facts.read`) —
 * `q` lets a caller pass a `limit`/`orderBy` for a large collection; the
 * default is unbounded. Same fail-soft discipline as `panelsForSurface`: a
 * `render` that throws is caught, logged, and skipped; a `render` returning
 * `undefined` is dropped. Not filtered by slot, same as `panelsForSurface` —
 * the slot rides along in the result.
 */
export async function renderCollectionPanels(
  kind: string,
  collectionName: string,
  q?: QuerySpec,
): Promise<RenderedPanel[]> {
  const surface = requireSurface(kind);
  if (!surface.render) {
    throw new Error(`surface "${kind}" has no render — the client renders it`);
  }
  const render = surface.render;
  const contributions = contributionsForSurface(kind).filter(
    (c) => c.collectionName === collectionName,
  );
  const facts = recordsAsFacts(queryRecords(collectionName, q));
  const results: RenderedPanel[] = [];
  for (const c of contributions) {
    const panel: SurfacePanel = {
      pluginId: c.pluginId,
      slot: c.slot,
      collectionName: c.collectionName,
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
