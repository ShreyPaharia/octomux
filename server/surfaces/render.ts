/**
 * server/surfaces/render.ts
 *
 * Resolves every `ctx.ui` panel binding against one surface's declared
 * renderers, loads the records each binding needs, and renders. This is the
 * seam the whole ticket is about: a binding written before a surface existed
 * still renders on it with zero change to the plugin that wrote the binding
 * (see `portability.test.ts`).
 */
import { childLogger } from '../logger.js';
import { toEnvelope } from '../plugins/records.js';
import { listUiContributions } from '../plugins/ui-registry.js';
import type { UiContribution } from '../plugins/ui-registry.js';
import { getSurface } from './registry.js';
import { readRecordsForTask, queryRecords } from '../repositories/plugin-records.js';
import type {
  QuerySpec,
  SurfaceDefinition,
  SurfacePanel,
  SurfacePrompt,
} from '@octomux/plugin-api';

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

/** Every ui contribution resolved for one surface, WITHOUT records. */
export function contributionsForSurface(
  kind: string,
): Array<UiContribution & { renderer: string }> {
  const surface = requireSurface(kind);
  return listUiContributions().map((c) => ({ ...c, renderer: resolveRenderer(surface, c.as) }));
}

async function renderContributions(
  kind: string,
  contributions: Array<UiContribution & { renderer: string }>,
  recordsFor: (c: UiContribution & { renderer: string }) => SurfacePanel['records'],
): Promise<RenderedPanel[]> {
  const surface = requireSurface(kind);
  if (!surface.render) {
    throw new Error(`surface "${kind}" has no render — the client renders it`);
  }
  const render = surface.render;
  const results: RenderedPanel[] = [];
  for (const c of contributions) {
    const panel: SurfacePanel = {
      pluginId: c.pluginId,
      slot: c.slot,
      recordStore: c.recordStore,
      as: c.as,
      renderer: c.renderer,
      value: c.value,
      delta: c.delta,
      title: c.title,
      records: recordsFor(c),
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

/** Two entry points, differing by WHAT is rendered — a task's panels, or one
 *  store's board — not by binding kind. The binding-kind branch is gone; the
 *  second function is not, because panelsForStore carries a QuerySpec that
 *  windows an unbounded store ("a 2,000-record board does not need every row in
 *  a Slack message"). A merged walk has nowhere to put per-store limit/offset,
 *  and one window shared across stores with different schemas is meaningless. */

/**
 * Loads each contribution's records for `taskId` and renders them into this
 * surface's transport. A panel whose `render` returns `undefined` is
 * dropped. A `render` that THROWS is caught and logged — one bad panel does
 * not blank the whole surface, same fail-soft discipline as the rest of the
 * plugin runtime.
 *
 * `readRecordsForTask` is scoped to `taskId`, so a binding on a DURABLE store
 * (whose rows all carry `taskId: null`) naturally comes back empty here —
 * no separate check needed to keep a durable-store panel off the task walk.
 */
export async function panelsForTask(kind: string, taskId: string): Promise<RenderedPanel[]> {
  const contributions = contributionsForSurface(kind);
  return renderContributions(kind, contributions, (c) =>
    readRecordsForTask(taskId, c.recordStore).map(toEnvelope),
  );
}

/**
 * Renders every panel bound to one record store on one surface — the
 * durable-board counterpart to `panelsForTask`, which only ever walks a
 * task's rows. `store` must already be QUALIFIED (`<pluginId>:<record>`,
 * what `UiContribution.recordStore` holds) — there is no plugin identity at
 * this call site to qualify a bare name against.
 *
 * Same preamble as `panelsForTask`: throws on an unknown surface, and throws
 * the same "the client renders it" error when `surface.render` is absent —
 * that is how the `web` surface DECLARES IT CANNOT render server-side, and
 * this path keeps that behaviour rather than working around it.
 *
 * Records are read ONCE via `queryRecords` (unscoped) — `q` lets a caller
 * pass a `limit`/`orderBy` for a large store; the default is unbounded. Same
 * fail-soft discipline as `panelsForTask`: a `render` that throws is caught,
 * logged, and skipped; a `render` returning `undefined` is dropped. Not
 * filtered by slot, same as `panelsForTask` — the slot rides along in the
 * result.
 */
export async function panelsForStore(
  kind: string,
  store: string,
  q?: QuerySpec,
): Promise<RenderedPanel[]> {
  const contributions = contributionsForSurface(kind).filter((c) => c.recordStore === store);
  const records = queryRecords(store, q).map(toEnvelope);
  return renderContributions(kind, contributions, () => records);
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
