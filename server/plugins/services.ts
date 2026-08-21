/**
 * `ctx.services` (SHR-260) — dependency by CAPABILITY, not by package name.
 *
 * Every other cross-plugin wire in this runtime is either anonymous (facts,
 * collections) or hard-coded (import `octomux-plugin-slack` and hope it's
 * installed). A service is the middle: a plugin says "I need something that
 * can send chat messages" (`chat.send`), another says "I am that", and neither
 * one names the other.
 *
 * ## Service names are NOT qualified
 *
 * Everything else a plugin registers gets prefixed with its own id
 * (`qualify.ts`) so two plugins can't collide. A service name is the exact
 * opposite: `chat.send` MUST mean the same string coming from every plugin or
 * the whole idea collapses back into naming packages. So the namespace is
 * shared and flat, and collisions are a feature — see the tie-break below.
 *
 * ## Tie-break: first provider wins
 *
 * Two plugins may provide the same name. The one that registered FIRST (i.e.
 * appears earlier in `octomux.yml`, since the loader walks rows in order) is
 * the live provider; later ones queue behind it and take over if it unmounts.
 * Manifest order is the rule — there is deliberately no `prefer:` key to
 * configure, because reordering two lines in a YAML file already expresses it.
 *
 * ## Resolution is at mount, not at call
 *
 * `ctx.services.require(name)` records a requirement and hands back a handle.
 * `server/plugins/loader.ts` checks every requirement once the whole manifest
 * has been applied — order-independent, so a consumer listed before its
 * provider still works — and an unmet one fails THAT plugin in the load
 * report, in the same `phase: 'apply'` shape an ungranted capability produces.
 * `handle.get()` resolves live on each call, so a provider that hot-reloads is
 * picked up without the consumer knowing.
 */
import { childLogger } from '../logger.js';

const logger = childLogger('plugins/services');

/** Dot-separated lowercase segments — `chat.send`, `ticket.create`, `notify`.
 *  Deliberately excludes `:` so a service name can never be mistaken for a
 *  qualified `<pluginId>:<kind>` id anywhere it's printed next to one. */
export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

interface ProviderEntry {
  pluginId: string;
  impl: unknown;
}

/** service name -> providers in registration order. Head is the live one. */
const providers = new Map<string, ProviderEntry[]>();

/** pluginId -> service names it declared via `ctx.services.require()`. */
const requirements = new Map<string, Set<string>>();

/** Registers an implementation. Called by `ctx.services.provide` AFTER the
 *  grant check. Throws if the same plugin provides the same name twice —
 *  that is a bug in the plugin, not a collision to arbitrate. */
export function registerService(pluginId: string, name: string, impl: unknown): void {
  if (!SERVICE_NAME_RE.test(name)) {
    throw new Error(
      `plugin "${pluginId}": service name ${JSON.stringify(name)} must match ${SERVICE_NAME_RE}`,
    );
  }
  if (impl === undefined || impl === null) {
    throw new Error(`plugin "${pluginId}": service "${name}" implementation must not be nullish`);
  }

  const entries = providers.get(name) ?? [];
  if (entries.some((e) => e.pluginId === pluginId)) {
    throw new Error(`plugin "${pluginId}": service "${name}" is already provided by this plugin`);
  }
  entries.push({ pluginId, impl });
  providers.set(name, entries);

  if (entries.length > 1) {
    logger.warn(
      { service: name, live: entries[0].pluginId, queued: pluginId },
      'more than one plugin provides this service — first one registered stays live',
    );
  }
}

/** The live implementation, or `undefined` when nothing provides `name`. */
export function getService(name: string): unknown | undefined {
  return providers.get(name)?.[0]?.impl;
}

/** The plugin id currently serving `name`, for logs and the load report. */
export function serviceProvider(name: string): string | undefined {
  return providers.get(name)?.[0]?.pluginId;
}

/** Records that `pluginId` needs `name`. Idempotent. */
export function requireService(pluginId: string, name: string): void {
  if (!SERVICE_NAME_RE.test(name)) {
    throw new Error(
      `plugin "${pluginId}": service name ${JSON.stringify(name)} must match ${SERVICE_NAME_RE}`,
    );
  }
  const set = requirements.get(pluginId) ?? new Set<string>();
  set.add(name);
  requirements.set(pluginId, set);
}

/** Service names `pluginId` requires that nothing currently provides. Sorted,
 *  so the load-report message is stable across runs. */
export function unmetRequirements(pluginId: string): string[] {
  const required = requirements.get(pluginId);
  if (!required) return [];
  return Array.from(required)
    .filter((name) => !providers.has(name))
    .sort();
}

/** Service names this plugin provides, for `ctx.catalog` / the unmount report. */
export function listPluginServices(pluginId: string): string[] {
  const names: string[] = [];
  for (const [name, entries] of providers) {
    if (entries.some((e) => e.pluginId === pluginId)) names.push(name);
  }
  return names.sort();
}

/**
 * Drops everything a plugin provided and required. Called on unmount. Returns
 * the names it had provided. A queued provider (see the tie-break above) is
 * promoted implicitly: it was already next in the array.
 */
export function unregisterPluginServices(pluginId: string): string[] {
  const dropped: string[] = [];
  for (const [name, entries] of providers) {
    const kept = entries.filter((e) => e.pluginId !== pluginId);
    if (kept.length === entries.length) continue;
    dropped.push(name);
    if (kept.length === 0) providers.delete(name);
    else providers.set(name, kept);
  }
  requirements.delete(pluginId);
  return dropped.sort();
}

/** Test-only: drops every provider and requirement. */
export function resetServices(): void {
  providers.clear();
  requirements.clear();
}
