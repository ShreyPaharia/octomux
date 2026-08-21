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
import type { UiPanelBinding, UiSlot } from '@octomux/plugin-api';
import { childLogger } from '../logger.js';
import { qualify } from './qualify.js';
import { isFactTypeDefined } from './facts.js';
import { isCollectionDefined } from './collections.js';

const logger = childLogger('plugins/ui-registry');

const UI_SLOTS: readonly UiSlot[] = [
  'task.panel',
  'task.badge',
  'board.card',
  'nav.section',
  'run.detail',
  'settings.card',
];

/** A binding as served to the client: the plugin's declaration with its fact
 *  or collection name qualified and its owner attached.
 *
 * `UiPanelBinding` became a union (`UiFactPanelBinding | UiCollectionPanelBinding`)
 * in SHR-275, so `interface UiContribution extends UiPanelBinding` no longer
 * typechecks — TS can't extend an interface onto a union. An intersection
 * (`UiPanelBinding & { ... }`) has the same effect: every contribution is
 * still exactly one of the two binding shapes, plus the fields below. */
export type UiContribution = UiPanelBinding & {
  /** Manifest row id of the contributing plugin. */
  pluginId: string;
  /** Qualified fact type — `<pluginId>:<fact>`. Present only on a fact-bound panel. */
  factType?: string;
  /** Qualified collection name — `<pluginId>:<collection>`. Present only on a
   *  collection-bound panel. */
  collectionName?: string;
};

/** pluginId -> its contributions, insertion order preserved. */
const contributions = new Map<string, UiContribution[]>();

/** Qualified fact types already warned about via `listUiContributions` — logs
 *  once per type, not once per request. */
const warnedMissingFactType = new Set<string>();

/** Qualified collection names already warned about via `listUiContributions`. */
const warnedMissingCollection = new Set<string>();

/** Registers a panel binding. `binding.fact` / `binding.collection` is BARE;
 * this qualifies whichever is present.
 *
 * Validates `binding.slot` against the six declared slots — an unknown slot
 * has nowhere in the client to render and is a plugin authoring bug, not a
 * degrade-gracefully case (contrast `binding.as`, an unknown renderer, which
 * the client renders as `json` rather than rejecting).
 *
 * Also requires exactly one of `binding.fact` / `binding.collection`. Neither
 * or both leaves nowhere (or two conflicting places) to resolve the panel's
 * data from — the same class of authoring bug as an unknown slot, so it
 * throws rather than degrading. `server/plugins/context.ts` used to check the
 * fact side of this (`requireLocalId(payload, 'fact', 'ui.panel')`); now that
 * `fact` is one of two valid binding targets, that check belongs here where
 * both are visible, not split across two files with the same ownership. */
export function registerPluginUiPanel(pluginId: string, binding: UiPanelBinding): void {
  if (!UI_SLOTS.includes(binding.slot)) {
    throw new Error(
      `plugin "${pluginId}": ui.panel "slot" must be one of ${UI_SLOTS.join(', ')} (got "${binding.slot}")`,
    );
  }
  const hasFact = binding.fact !== undefined;
  const hasCollection = binding.collection !== undefined;
  if (hasFact === hasCollection) {
    throw new Error(
      `plugin "${pluginId}": ui.panel binding must set exactly one of "fact" or "collection" ` +
        `(got ${hasFact ? 'both' : 'neither'})`,
    );
  }
  const factType = hasFact ? qualify(pluginId, binding.fact as string) : undefined;
  const collectionName = hasCollection
    ? qualify(pluginId, binding.collection as string)
    : undefined;
  const contribution: UiContribution = { ...binding, pluginId, factType, collectionName };

  let pluginContributions = contributions.get(pluginId);
  if (!pluginContributions) {
    pluginContributions = [];
    contributions.set(pluginId, pluginContributions);
  }
  pluginContributions.push(contribution);
  logger.info(
    {
      plugin_id: pluginId,
      slot: binding.slot,
      fact_type: factType,
      collection_name: collectionName,
      as: binding.as,
    },
    'plugin ui panel registered',
  );
}

/**
 * Every contribution, for `GET /api/plugin-ui/contributions`.
 *
 * Also where a `binding.fact` typo gets its only diagnostic: checked here
 * rather than in `registerPluginUiPanel` because ordering between
 * `facts.define()` and `ui.panel()` inside one `apply()` is the plugin
 * author's choice — checking at registration time would false-positive
 * whenever `ui.panel()` runs first. By the time anything reads this list,
 * every plugin's `apply()` has already returned, so a still-undefined type
 * is a real typo, not a race. A NOT-throw: an unmatched binding renders as a
 * permanently empty panel, which is a plugin authoring bug, not a reason to
 * 500 every other plugin's panels too.
 *
 * SHR-275 extends the same check to a collection-bound binding, for the same
 * reason: `collections.define()` / `ui.panel({ collection })` ordering inside
 * one `apply()` is the plugin author's choice too.
 */
export function listUiContributions(): UiContribution[] {
  const all = Array.from(contributions.values()).flat();
  for (const c of all) {
    if (c.factType && !isFactTypeDefined(c.factType) && !warnedMissingFactType.has(c.factType)) {
      warnedMissingFactType.add(c.factType);
      logger.warn(
        { plugin_id: c.pluginId, slot: c.slot, fact_type: c.factType },
        'ui.panel binds a fact type that was never defined — check binding.fact for a typo',
      );
    }
    if (
      c.collectionName &&
      !isCollectionDefined(c.collectionName) &&
      !warnedMissingCollection.has(c.collectionName)
    ) {
      warnedMissingCollection.add(c.collectionName);
      logger.warn(
        { plugin_id: c.pluginId, slot: c.slot, collection_name: c.collectionName },
        'ui.panel binds a collection that was never defined — check binding.collection for a typo',
      );
    }
  }
  return all;
}

/** Drops a plugin's contributions. Called on unmount — the panel must vanish
 *  with no restart. Safe to call for a plugin that registered none. */
export function unregisterPluginUi(pluginId: string): void {
  if (!contributions.delete(pluginId)) return;
  logger.info({ plugin_id: pluginId }, 'plugin ui contributions unregistered');
}

/** Test-only: clears all contributions and the missing-fact-type /
 *  missing-collection warn dedupes. */
export function resetPluginUi(): void {
  contributions.clear();
  warnedMissingFactType.clear();
  warnedMissingCollection.clear();
}
