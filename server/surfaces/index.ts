/**
 * server/surfaces/index.ts — barrel. Mirrors `server/compute/index.ts`.
 *
 * Registers the four core surfaces and freezes them against redefinition
 * before any plugin can load, then re-exports the registry + render API.
 */
import { registerCoreSurfaces } from './core.js';
import { freezeCoreSurfaces } from './registry.js';

registerCoreSurfaces();
// Lock the core kinds against redefinition now that all four have
// registered, and before any plugin surface gets a chance to load.
freezeCoreSurfaces();

export {
  registerSurface,
  getSurface,
  listSurfaces,
  DEFAULT_SURFACE_KIND,
  CORE_SURFACE_KINDS,
  freezeCoreSurfaces,
  resetSurfaces,
  unregisterSurface,
} from './registry.js';
export { registerCoreSurfaces, WEB_RENDERERS } from './core.js';
export { renderPanelText } from './text.js';
export {
  resolveRenderer,
  contributionsForSurface,
  panelsForTask,
  panelsForStore,
  promptOn,
} from './render.js';
export type { RenderedPanel } from './render.js';
