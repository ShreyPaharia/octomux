/**
 * `ctx.catalog` (SHR-268) — a READ API over what is installed: this plugin's
 * own registrations, a sibling's, and core's, computed live from the same
 * registries every other `ctx.*` surface writes into (workflows, harnesses,
 * providers, `http-registry.ts`, `ui-registry.ts`, `facts.ts`) plus, for
 * `octomux doctor`'s no-server case, a persisted `LoadReport`.
 *
 * It is NOT a registry: there is no write path and no override path here.
 * "What's installed" is a query, never an implementation choice — a plugin
 * cannot alter its own or anyone else's entry through this surface. It also
 * replaces the hand-rolled "what did plugin X register" prefix scans that
 * used to live only in `lifecycle.ts`'s unmount sequence — that scan and
 * `ctx.catalog` were computing the same thing from two places.
 */
import { listWorkflows } from '../workflows/registry.js';
import { listHarnesses } from '../harnesses/registry.js';
import { listProviders } from '../integrations/registry.js';
import { listCompute } from '../compute/registry.js';
import { listSurfaces } from '../surfaces/index.js';
import { listPluginRoutes, RESERVED_ROUTE_PLUGIN_IDS } from './http-registry.js';
import { listUiContributions } from './ui-registry.js';
import { listPluginFactTypes, CORE_FACT_TYPES } from './facts.js';
import { listPluginCollections } from './collections.js';
import type { CatalogEntry, LoadReport } from '@octomux/plugin-api';

// getMountedPlugin/listMountedPluginIds come from loader.js, which itself
// imports createPluginContext from context.js, which wires ctx.catalog to
// listCatalog() below — an import cycle (loader -> context -> catalog ->
// loader). Safe: all three are hoisted function declarations, called lazily
// at request time, never referenced during module evaluation. Do not "fix"
// this by growing a second, duplicate mounted-plugin map here.
import { getMountedPlugin, listMountedPluginIds } from './loader.js';

/** Structured snapshot of everything ONE plugin currently has in the live
 *  registries. The single prefix-scan implementation — `lifecycle.ts`'s
 *  unmount sequence and `provides` both read it. */
export interface PluginRegistrations {
  workflowKinds: string[];
  harnessIds: string[];
  providerKinds: string[];
  /** `ctx.compute.register()` kinds owned by this plugin (SHR-261). */
  computeKinds: string[];
  /** `ctx.surfaces.register()` kinds owned by this plugin (SHR-267). */
  surfaceKinds: string[];
  /** `"METHOD /path"` entries, from `listPluginRoutes()`. */
  routes: string[];
  uiSlots: string[];
  factTypes: string[];
  /** `ctx.collections.define()` names owned by this plugin (SHR-275). */
  collectionNames: string[];
}

function belongsTo(pluginId: string, id: string): boolean {
  return id.startsWith(`${pluginId}:`);
}

function isCore(id: string): boolean {
  return !id.includes(':');
}

export function pluginRegistrations(pluginId: string): PluginRegistrations {
  return {
    workflowKinds: listWorkflows()
      .map((w) => w.kind)
      .filter((kind) => belongsTo(pluginId, kind)),
    harnessIds: listHarnesses()
      .map((h) => h.id)
      .filter((id) => belongsTo(pluginId, id)),
    providerKinds: listProviders()
      .map((p) => p.kind)
      .filter((kind) => belongsTo(pluginId, kind)),
    computeKinds: listCompute()
      .map((c) => c.kind)
      .filter((kind) => belongsTo(pluginId, kind)),
    surfaceKinds: listSurfaces()
      .map((s) => s.kind)
      .filter((kind) => belongsTo(pluginId, kind)),
    routes: listPluginRoutes(pluginId),
    uiSlots: listUiContributions()
      .filter((c) => c.pluginId === pluginId)
      .map((c) => c.slot),
    factTypes: listPluginFactTypes(pluginId),
    collectionNames: listPluginCollections(pluginId),
  };
}

/** Flattened `provides[]` form of `pluginRegistrations()`. Order: workflows,
 *  harnesses, integrations, surfaces, routes, ui, facts, collections. */
function provides(reg: PluginRegistrations): string[] {
  return [
    ...reg.workflowKinds.map((k) => `workflow:${k}`),
    ...reg.harnessIds.map((h) => `harness:${h}`),
    ...reg.providerKinds.map((p) => `integration:${p}`),
    ...reg.surfaceKinds.map((s) => `surface:${s}`),
    ...reg.routes.map((r) => `route:${r}`),
    ...reg.uiSlots.map((s) => `ui:${s}`),
    ...reg.factTypes.map((f) => `fact:${f}`),
    ...reg.collectionNames.map((c) => `collection:${c}`),
  ];
}

/** Flattened `provides[]` form of the above. */
export function pluginProvides(pluginId: string): string[] {
  return provides(pluginRegistrations(pluginId));
}

/** Core's own registrations — everything registered WITHOUT a `<pluginId>:`
 *  qualification. Routes are the exception: `http-registry.ts` keys its
 *  table by the raw plugin/manifest id, never a qualified one, so core's
 *  routes live under `RESERVED_ROUTE_PLUGIN_IDS` (`pr-extract` today)
 *  instead of behind a colon check. */
function coreRegistrations(): PluginRegistrations {
  return {
    workflowKinds: listWorkflows()
      .map((w) => w.kind)
      .filter(isCore),
    harnessIds: listHarnesses()
      .map((h) => h.id)
      .filter(isCore),
    computeKinds: listCompute()
      .map((c) => c.kind)
      .filter(isCore),
    surfaceKinds: listSurfaces()
      .map((s) => s.kind)
      .filter(isCore),
    providerKinds: listProviders()
      .map((p) => p.kind)
      .filter(isCore),
    routes: (RESERVED_ROUTE_PLUGIN_IDS as readonly string[]).flatMap((id) => listPluginRoutes(id)),
    // Core never calls ctx.ui.panel() — there is no core producer of ui
    // contributions today, so this is always empty, not filtered.
    uiSlots: [],
    factTypes: [...CORE_FACT_TYPES],
    // Core never calls ctx.collections.define() — nothing in server/ defines
    // a collection today, so this is always empty, not filtered.
    collectionNames: [],
  };
}

/** The `core` entry — everything registered WITHOUT a `<pluginId>:` qualification. */
export function coreCatalogEntry(): CatalogEntry {
  return {
    id: 'core',
    kind: 'core',
    provides: provides(coreRegistrations()),
    source: 'built-in',
  };
}

function sourceFor(name: string, version: string | undefined, resolvedPath: string): string {
  return version ? `${name}@${version}` : resolvedPath;
}

/** Live catalog: one entry per currently-mounted plugin (identity from the
 *  loader's `mounted` map, `provides` computed live so a hot reload is
 *  reflected immediately) plus the `core` entry. */
export function listCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const id of listMountedPluginIds()) {
    const mount = getMountedPlugin(id);
    if (!mount) continue;
    entries.push({
      id,
      kind: 'plugin',
      provides: pluginProvides(id),
      source: sourceFor(mount.row.name, mount.row.version, mount.resolvedPath),
    });
  }
  entries.push(coreCatalogEntry());
  return entries;
}

/** Catalog rebuilt from a persisted `LoadReport` — for `octomux doctor`, which
 *  runs with no server and only has the JSON file. Plugin entries only. */
export function buildCatalog(report: LoadReport): CatalogEntry[] {
  return report.loaded.map((p) => ({
    id: p.id,
    kind: 'plugin' as const,
    provides: p.provides ?? [],
    // `LoadedPlugin.version` is never optional — `loader.ts` substitutes the
    // literal `'unknown'` for a manifest row that declared none. Map it back
    // to "no version" so a version-less row reports the same `source` here as
    // it does live through `listCatalog()` (its resolved path), rather than
    // `name@unknown` from one path and a path from the other.
    source: sourceFor(p.name, p.version === 'unknown' ? undefined : p.version, p.resolvedPath),
  }));
}
