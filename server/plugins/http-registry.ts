/**
 * Plugin route table — the replacement for handing a plugin an Express Router.
 *
 * `WorkflowType.apiRouter` gave a plugin a `Router`, and express 5 cannot
 * unmount one. That is the entire reason `plans/2026-08-16-plugin-ecosystem.md`
 * lists "Unload / hot reload" under Non-goals, and the cost was paid by every
 * plugin including the ones that never serve a route.
 *
 * Here routes are rows in a lookup table behind ONE permanently-mounted parent
 * router (`server/api.ts` mounts it at `/api/p`). Dispatch is a table lookup on
 * the qualified path. Removing a plugin deletes its rows — no unmount required,
 * because nothing was ever mounted.
 *
 * SIGNATURES ARE PINNED (plans/2026-08-20-plugin-runtime-p0.md STEP-0).
 * Task A fills in the bodies; nothing here may change shape.
 */
import { Router } from 'express';
import type { HttpMethod, PluginRouteHandler } from '@octomux/plugin-api';

const notImplemented = (what: string): never => {
  throw new Error(`${what}: not implemented — SHR-253 (task A) owns this module`);
};

/** Registers one route for a plugin. Throws on a duplicate `METHOD path` for
 *  the same plugin — silent last-write-wins hides a real authoring bug. */
export function registerPluginRoute(
  _pluginId: string,
  _method: HttpMethod,
  _path: string,
  _handler: PluginRouteHandler,
): void {
  notImplemented('registerPluginRoute');
}

/** Drops every route a plugin registered. Safe to call for a plugin that
 *  registered none — unmount calls it unconditionally. */
export function unregisterPluginRoutes(_pluginId: string): void {
  notImplemented('unregisterPluginRoutes');
}

/** Route count per plugin id, for `octomux doctor`. */
export function pluginRouteCounts(): Record<string, number> {
  return notImplemented('pluginRouteCounts');
}

/**
 * The single parent router. Mounted once at boot by `setupRoutes()` and never
 * unmounted. A path with no matching row 404s here rather than falling through
 * to the rest of the app — `/api/p/*` belongs to plugins entirely.
 *
 * STEP-0 ships the empty-table behaviour (every path 404s) rather than a
 * throwing stub: this sits on the boot path via `setupRoutes()`, and ~40
 * supertest suites call `createApp()` directly. A stub that throws here takes
 * every one of them down. Task A replaces the body with the real table lookup.
 */
export function createPluginParentRouter(): Router {
  const router: Router = Router();
  // Path-less terminal middleware, deliberately NOT `router.all(<pattern>, ...)`:
  // `server/registry/route-inventory.ts` walks the express layer stack and
  // assumes every layer's path is a string, so a RegExp route here crashes the
  // drift test. A `use` layer contributes no route entry at all, which is also
  // what we want — /api/p is a table, not a declared surface.
  router.use((_req, res) => {
    res.status(404).json({ error: 'no such plugin route' });
  });
  return router;
}

/** Test-only: clears the whole table. */
export function resetPluginRoutes(): void {
  notImplemented('resetPluginRoutes');
}
