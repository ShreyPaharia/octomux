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
 *
 * SHR-257 adds the write half: `ctx.ui.action()`. An action is a NAME the
 * host invokes — `def.run` is stored here and NEVER served over
 * `listUiActions()`; only its label/slot/schema/command/confirm reach the
 * client (`UiActionContribution`). Invocation goes through `invokeUiAction()`,
 * which runs `run` in this process and hands back only its JSON-serializable
 * result. That is the same "no plugin JavaScript in the browser" ceiling the
 * panel side holds to, extended to writes: a plugin can make the host do
 * something, but it can never ship code that runs on someone else's machine.
 */
import type {
  UiActionContribution,
  UiActionDefinition,
  UiActionResult,
  UiPanelBinding,
  UiSlot,
} from '@octomux/plugin-api';
import { childLogger } from '../logger.js';
import { qualify } from './qualify.js';
import { isFactTypeDefined } from './facts.js';
import { isCollectionDefined } from './collections.js';
import { forgetCompiledSchema, validateAgainstSchema } from '../services/output-contract.js';

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

/** One registered action: the client-facing contribution plus the host-only
 *  `run` function. Never destructure this into anything that leaves the
 *  module — `run` crossing a boundary is exactly what this table exists to
 *  prevent. */
interface UiActionRegistration {
  contribution: UiActionContribution;
  run: UiActionDefinition['run'];
}

/** pluginId -> its actions, insertion order preserved (mirrors `contributions`). */
const actionsByPlugin = new Map<string, UiActionRegistration[]>();

/** Qualified actionId -> registration, for O(1) invoke. */
const actionsById = new Map<string, UiActionRegistration>();

/**
 * Registers an action. `def.id` is BARE; this qualifies it to
 * `<pluginId>:<id>` the same way `registerPluginUiPanel` qualifies
 * `binding.fact`/`binding.collection`.
 *
 * Validates `id`/`label`/`run`/`slot` at registration time (unlike the panel
 * side's fact-type typo check, which waits until read time) — there is no
 * legitimate ordering dependency here the way there is between
 * `facts.define()` and `ui.panel()`, so a bad declaration is a load-time
 * failure, not a permanently-broken button nobody is told about.
 */
export function registerPluginUiAction(pluginId: string, def: UiActionDefinition): void {
  if (typeof def.id !== 'string' || def.id.length === 0) {
    throw new Error(`plugin "${pluginId}": ui.action requires a non-empty string "id"`);
  }
  if (typeof def.label !== 'string' || def.label.length === 0) {
    throw new Error(
      `plugin "${pluginId}": ui.action "${def.id}" requires a non-empty string "label"`,
    );
  }
  if (typeof def.run !== 'function') {
    throw new Error(`plugin "${pluginId}": ui.action "${def.id}" requires a "run" function`);
  }
  if (def.slot !== undefined && !UI_SLOTS.includes(def.slot)) {
    throw new Error(
      `plugin "${pluginId}": ui.action "${def.id}" "slot" must be one of ${UI_SLOTS.join(', ')} ` +
        `(got "${def.slot}")`,
    );
  }

  const actionId = qualify(pluginId, def.id);
  if (actionsById.has(actionId)) {
    throw new Error(`plugin "${pluginId}": ui action "${actionId}" is already defined`);
  }

  const contribution: UiActionContribution = {
    pluginId,
    actionId,
    id: def.id,
    label: def.label,
    slot: def.slot,
    schema: def.schema,
    command: def.command,
    confirm: def.confirm,
  };
  const registration: UiActionRegistration = { contribution, run: def.run };

  let pluginActions = actionsByPlugin.get(pluginId);
  if (!pluginActions) {
    pluginActions = [];
    actionsByPlugin.set(pluginId, pluginActions);
  }
  pluginActions.push(registration);
  actionsById.set(actionId, registration);

  logger.info(
    {
      plugin_id: pluginId,
      action_id: actionId,
      slot: def.slot,
      has_schema: def.schema !== undefined,
      command: def.command === true,
    },
    'plugin ui action registered',
  );
}

/** Every action contribution — `run` never appears in this shape — for
 *  `GET /api/plugin-ui/actions`, optionally filtered by slot. Insertion
 *  order, same as `listUiContributions()`. */
export function listUiActions(slot?: UiSlot | string): UiActionContribution[] {
  const all = Array.from(actionsByPlugin.values())
    .flat()
    .map((r) => r.contribution);
  return slot === undefined ? all : all.filter((c) => c.slot === slot);
}

/** Qualified action ids owned by one plugin — for `ctx.catalog` / unmount
 *  accounting, same role as `listPluginFactTypes`. */
export function listPluginUiActionIds(pluginId: string): string[] {
  return (actionsByPlugin.get(pluginId) ?? []).map((r) => r.contribution.actionId);
}

/**
 * Runs a registered action. `actionId` is QUALIFIED.
 *
 * Input handling: `invocation.input` defaults to `{}` when absent. When the
 * action declared a `schema`, the input is validated against it (same
 * `validateAgainstSchema` call `putFact` makes) and a violation throws with a
 * message starting `invalid input for ui action ` — the route
 * (`server/routes/plugin-ui.ts`) maps that prefix to 400. With no schema, the
 * input must be a plain object (or absent) — anything else is the same
 * "invalid input" error, since there is no schema to say what shape is
 * expected instead.
 *
 * An unknown `actionId` throws a message starting `unknown ui action ` —
 * the route maps that prefix to 404.
 */
export async function invokeUiAction(
  actionId: string,
  invocation: { taskId?: string; input?: unknown },
): Promise<UiActionResult | undefined> {
  const registration = actionsById.get(actionId);
  if (!registration) {
    throw new Error(`unknown ui action "${actionId}"`);
  }
  const { contribution } = registration;
  const { pluginId } = contribution;

  const rawInput = invocation.input ?? {};
  let input: Record<string, unknown>;
  if (contribution.schema) {
    const result = validateAgainstSchema(actionId, contribution.schema, rawInput);
    if (!result.valid) {
      const detail = (result.errors ?? []).join('; ') || 'invalid payload';
      throw new Error(`invalid input for ui action "${actionId}": ${detail}`);
    }
    input = rawInput as Record<string, unknown>;
  } else {
    if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
      throw new Error(`invalid input for ui action "${actionId}": expected an object`);
    }
    input = rawInput as Record<string, unknown>;
  }

  logger.info(
    { plugin_id: pluginId, action_id: actionId, task_id: invocation.taskId },
    'invoking plugin ui action',
  );
  try {
    const result = await registration.run({ taskId: invocation.taskId, input });
    return result ?? undefined;
  } catch (err) {
    childLogger(`plugin:${pluginId}`).warn(
      { task_id: invocation.taskId, action_id: actionId, err },
      'ui action run() threw',
    );
    throw err;
  }
}

/** Drops a plugin's contributions (panels AND actions). Called on unmount —
 *  everything must vanish with no restart. Safe to call for a plugin that
 *  registered none, or registered only one of the two kinds. */
export function unregisterPluginUi(pluginId: string): void {
  const hadPanels = contributions.delete(pluginId);

  const pluginActions = actionsByPlugin.get(pluginId);
  const hadActions = pluginActions !== undefined;
  if (pluginActions) {
    for (const reg of pluginActions) {
      actionsById.delete(reg.contribution.actionId);
      forgetCompiledSchema(reg.contribution.actionId);
    }
    actionsByPlugin.delete(pluginId);
  }

  if (!hadPanels && !hadActions) return;
  logger.info({ plugin_id: pluginId }, 'plugin ui contributions unregistered');
}

/** Test-only: clears all contributions/actions and the missing-fact-type /
 *  missing-collection warn dedupes. */
export function resetPluginUi(): void {
  contributions.clear();
  actionsByPlugin.clear();
  actionsById.clear();
  warnedMissingFactType.clear();
  warnedMissingCollection.clear();
}
