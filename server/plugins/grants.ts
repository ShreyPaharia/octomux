/**
 * Manifest capability grants (SHR-259).
 *
 * A manifest row declares the `ctx` capabilities its plugin needs. Anything
 * undeclared is **denied** — the registrar throws, `apply()` fails, and the row
 * lands in the load report as a failure with a message naming the plugin and
 * the capability. There is no warn-and-continue path: a warning nobody reads is
 * not a decision.
 *
 * ## What this is, and what it is not
 *
 * A plugin runs **in-process**, with the DB handle, every credential, and
 * `process.env`. It can do everything core can do without ever touching `ctx`.
 * A grant therefore confines nothing. It is a **coordination and audit
 * mechanism**: it records what a plugin says it needs, enforces that claim at
 * core's own seams, makes it reviewable (`octomux doctor`), and gives a human a
 * reason to look twice when a row asks for `policy.intercept`. Nothing in this
 * file is a sandbox, and no amount of it makes installing a plugin safer than
 * running its code yourself — because that is what installing it does.
 *
 * ## The acknowledgement ledger
 *
 * Widening an existing row's grants must not take effect silently — an
 * `npm update` that also edits `octomux.yml` would otherwise hand a plugin the
 * veto without anyone deciding to. So the acknowledged set per row is persisted
 * next to the manifest in `plugin-grants.json`:
 *
 * - row not in the ledger  -> first sight, the user just added it: grant it all
 *                             and record what was granted
 * - declared ⊆ acknowledged -> grant the declared set (narrowing is free), and
 *                             re-record so the ledger tracks the narrowing
 * - declared ⊄ acknowledged -> grant only the intersection; the added grants are
 *                             PENDING and withheld until `octomux plugins
 *                             approve <id>`
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { PluginCapability } from '@octomux/plugin-api';
import { childLogger } from '../logger.js';

const logger = childLogger('plugins/grants');

/** Every capability a manifest row may grant. Mirrors `PluginCapability`. */
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  'workflows.register',
  'integrations.register',
  'harnesses.register',
  'compute.register',
  'http.route',
  'facts.define',
  'facts.put',
  'collections.define',
  'collections.write',
  'ui.panel',
  'artifacts.write',
  'policy.intercept',
  'agents.run',
  'fanout.run',
  'surfaces.register',
  'secrets.read',
];

export function isPluginCapability(value: unknown): value is PluginCapability {
  return typeof value === 'string' && (PLUGIN_CAPABILITIES as readonly string[]).includes(value);
}

/** pluginId -> its effective grant set. Same shape as the other in-memory
 *  registries in this dir (e.g. `http-registry.ts`'s route table). */
const grantsMap = new Map<string, Set<PluginCapability>>();

/** Records the effective grant set for a plugin id. Called by the loader
 *  before `apply()` runs. Replaces any previous set for that id. */
export function setPluginGrants(pluginId: string, granted: readonly PluginCapability[]): void {
  grantsMap.set(pluginId, new Set(granted));
}

/** The effective grants for a plugin id — empty when nothing was recorded. */
export function getPluginGrants(pluginId: string): PluginCapability[] {
  return Array.from(grantsMap.get(pluginId) ?? []);
}

/** Every recorded grant set, for the load report / `octomux doctor`. */
export function allPluginGrants(): Record<string, PluginCapability[]> {
  const out: Record<string, PluginCapability[]> = {};
  for (const [pluginId, granted] of grantsMap) {
    out[pluginId] = Array.from(granted);
  }
  return out;
}

/** Drops a plugin's grants. Called on unmount. */
export function clearPluginGrants(pluginId: string): void {
  grantsMap.delete(pluginId);
}

/**
 * Throws unless `pluginId` holds `capability`. The message names the plugin,
 * the capability, and the exact manifest line that would fix it — this is the
 * error a plugin author sees first, so it has to be actionable.
 */
export function assertGranted(pluginId: string, capability: PluginCapability): void {
  if (grantsMap.get(pluginId)?.has(capability)) return;
  throw new Error(
    `plugin "${pluginId}": capability "${capability}" is not granted. Add it to the ` +
      `plugin's row in octomux.yml:\n    grants: [${capability}]`,
  );
}

export interface ResolvedGrants {
  /** What the plugin actually gets this boot. */
  effective: PluginCapability[];
  /** Declared but not yet acknowledged — withheld. */
  pending: PluginCapability[];
}

/** `<dir of the manifest>/plugin-grants.json`. Co-located with the manifest so
 *  a fixture manifest in a tmpdir gets a fixture ledger, never the real one. */
export function grantLedgerPath(manifestPath: string): string {
  return path.join(path.dirname(manifestPath), 'plugin-grants.json');
}

/** Writes `text` to `file` atomically (temp file + rename), same approach as
 *  `cli/src/commands/plugins.ts`'s `atomicWriteFileSync` — not imported from
 *  there since `cli/` and `server/` are separate deploy units. */
function atomicWriteFileSync(file: string, text: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmp, text, 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Reads the ledger. A missing or unparseable file is an empty ledger — a
 *  corrupt ledger must not brick boot, it just re-asks for acknowledgement. */
export function readGrantLedger(manifestPath: string): Record<string, PluginCapability[]> {
  const file = grantLedgerPath(manifestPath);
  if (!fs.existsSync(file)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    logger.warn({ file, err }, 'plugin grant ledger is not valid JSON — treating as empty');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn({ file }, 'plugin grant ledger is not an object — treating as empty');
    return {};
  }

  const out: Record<string, PluginCapability[]> = {};
  for (const [pluginId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out[pluginId] = value.filter(isPluginCapability);
  }
  return out;
}

/** Writes the acknowledged set for one plugin id, atomically. A write failure
 *  is logged and swallowed — the acknowledgement is best-effort; the effective
 *  grants for this boot were already decided by the caller. */
export function acknowledgeGrants(
  manifestPath: string,
  pluginId: string,
  granted: readonly PluginCapability[],
): void {
  const file = grantLedgerPath(manifestPath);
  const ledger = readGrantLedger(manifestPath);
  const next = Array.from(new Set(granted));
  // Idempotent: re-acknowledging the same set is the common case (every boot
  // of an unchanged install goes through here), and rewriting the file for it
  // churns the ledger's mtime for nothing.
  const current = ledger[pluginId];
  if (current && current.length === next.length && next.every((cap) => current.includes(cap))) {
    return;
  }
  ledger[pluginId] = next;
  try {
    atomicWriteFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
  } catch (err) {
    logger.warn({ file, plugin_id: pluginId, err }, 'failed to write plugin grant ledger');
  }
}

/**
 * Splits a row's declared grants into effective + pending against the ledger,
 * acknowledging first-sight and narrowed rows as a side effect.
 */
export function resolveGrantsForRow(
  manifestPath: string,
  pluginId: string,
  declared: readonly PluginCapability[] | undefined,
): ResolvedGrants {
  const declaredArr = Array.from(new Set(declared ?? []));
  const ledger = readGrantLedger(manifestPath);
  const acknowledged = ledger[pluginId];

  if (acknowledged === undefined) {
    // First sight: the user just added this row (or these grants). Grant it
    // all and record what was granted.
    acknowledgeGrants(manifestPath, pluginId, declaredArr);
    return { effective: declaredArr, pending: [] };
  }

  const acknowledgedSet = new Set(acknowledged);
  const isNarrowingOrEqual = declaredArr.every((cap) => acknowledgedSet.has(cap));
  if (isNarrowingOrEqual) {
    // declared ⊆ acknowledged — narrowing (or unchanged) is free, but
    // re-record so the ledger tracks the narrowing.
    acknowledgeGrants(manifestPath, pluginId, declaredArr);
    return { effective: declaredArr, pending: [] };
  }

  // declared ⊄ acknowledged — grant only the intersection; the newly added
  // grants are pending until explicitly approved. Do NOT acknowledge: that
  // would silently approve what the user hasn't seen yet.
  const effective = declaredArr.filter((cap) => acknowledgedSet.has(cap));
  const pending = declaredArr.filter((cap) => !acknowledgedSet.has(cap));
  return { effective, pending };
}

/** Test-only: clears the in-memory grant map. */
export function resetPluginGrants(): void {
  grantsMap.clear();
}
