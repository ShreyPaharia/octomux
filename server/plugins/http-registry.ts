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
import type { Request, Response, NextFunction } from 'express';
import type {
  HttpMethod,
  PluginRequest,
  PluginResponse,
  PluginRouteHandler,
} from '@octomux/plugin-api';
import { childLogger } from '../logger.js';

const logger = childLogger('plugins/http-registry');

/**
 * Plugin ids core itself registers routes under. Nothing reserves the id
 * namespace by default — a third-party manifest row with `id: pr-extract`
 * would otherwise share pr-extract's own bucket in `table`, and that
 * plugin's unmount (`unregisterPluginRoutes`) would delete core's routes
 * along with its own. Same shape as `CORE_HARNESS_IDS`
 * (`server/harnesses/registry.ts`) / `CORE_PROVIDER_KINDS`
 * (`server/integrations/registry.ts`).
 */
export const RESERVED_ROUTE_PLUGIN_IDS = ['pr-extract'] as const;

let frozen = false;

/**
 * Locks `RESERVED_ROUTE_PLUGIN_IDS` against further registration. Call once
 * core's own routes under a reserved id have registered (`pr-extract/routes.ts`
 * calls this at module scope, right after its own `registerPluginRoute`
 * calls) and before any plugin's `apply()` can run.
 */
export function freezeCoreHttpRoutes(): void {
  frozen = true;
}

interface RouteEntry {
  method: HttpMethod;
  path: string; // normalized: always starts with '/'
  handler: PluginRouteHandler;
}

/**
 * pluginId -> "METHOD /path" -> entry. Insertion order preserved (Map), so
 * dispatch tries routes in registration order for a given plugin.
 *
 * FIRST MATCH WINS, and there is no specificity ranking — unlike express's own
 * router, a param pattern registered before a literal one permanently shadows
 * it. Register `/coverage/latest` BEFORE `/coverage/:task`, or the literal
 * route is unreachable. Deterministic, but a cheap footgun to hit.
 */
const table = new Map<string, Map<string, RouteEntry>>();

function normalizePath(path: string): string {
  if (path === '') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function routeKey(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Matches a registered pattern (`/coverage/:task`) against an actual request
 * path (`/coverage/123`), segment by segment. No wildcards, no optional
 * segments, no regex — plugin route paths are simple `:param` shapes, and a
 * hand-rolled segment matcher is the whole job (`path-to-regexp` isn't a
 * declared dependency of this package; express only carries it transitively).
 * Returns the extracted params on a match, `null` on a miss.
 */
function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const patternSegs = pattern.split('/').filter(Boolean);
  const actualSegs = actual.split('/').filter(Boolean);
  if (patternSegs.length !== actualSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const p = patternSegs[i];
    const a = actualSegs[i];
    if (p.startsWith(':')) {
      // decodeURIComponent throws URIError on a malformed percent-sequence
      // (`%ZZ`). This runs inside the router's synchronous middleware, BEFORE
      // the Promise wrapper around the handler call, so an unguarded throw
      // escapes to express's error middleware and any client could turn a
      // would-be 404 into a 500 — plus an error-level log line — for free.
      // A segment that cannot be decoded is simply not a match.
      let decoded: string;
      try {
        decoded = decodeURIComponent(a);
      } catch {
        return null;
      }
      params[p.slice(1)] = decoded;
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

/** Registers one route for a plugin. Throws on a duplicate `METHOD path` for
 *  the same plugin — silent last-write-wins hides a real authoring bug. */
export function registerPluginRoute(
  pluginId: string,
  method: HttpMethod,
  path: string,
  handler: PluginRouteHandler,
): void {
  // Checked first, same reasoning as the harness/provider registries: once
  // frozen, a reserved id is permanently closed to new registrations, core's
  // own included — core only ever registers once, at boot, before freezing.
  if (frozen && (RESERVED_ROUTE_PLUGIN_IDS as readonly string[]).includes(pluginId)) {
    logger.warn(
      { plugin_id: pluginId, method, path },
      'refusing to register under reserved route plugin id',
    );
    return;
  }
  const normalizedMethod = method.toUpperCase() as HttpMethod;
  const normalizedPath = normalizePath(path);
  const key = routeKey(normalizedMethod, normalizedPath);

  let pluginRoutes = table.get(pluginId);
  if (!pluginRoutes) {
    pluginRoutes = new Map();
    table.set(pluginId, pluginRoutes);
  }
  if (pluginRoutes.has(key)) {
    throw new Error(`plugin "${pluginId}": route "${key}" is already registered`);
  }
  pluginRoutes.set(key, { method: normalizedMethod, path: normalizedPath, handler });
  logger.info(
    { plugin_id: pluginId, method: normalizedMethod, path: normalizedPath },
    'plugin route registered',
  );
}

/** Drops every route a plugin registered. Safe to call for a plugin that
 *  registered none — unmount calls it unconditionally. Refuses (logs a warn,
 *  no-op) on any `RESERVED_ROUTE_PLUGIN_IDS` member — a plugin that squats a
 *  reserved id must never be able to take core's routes down with it. */
export function unregisterPluginRoutes(pluginId: string): void {
  if ((RESERVED_ROUTE_PLUGIN_IDS as readonly string[]).includes(pluginId)) {
    logger.warn({ plugin_id: pluginId }, 'refusing to unregister reserved route plugin id');
    return;
  }
  const pluginRoutes = table.get(pluginId);
  if (!pluginRoutes) return;
  table.delete(pluginId);
  logger.info(
    { plugin_id: pluginId, route_count: pluginRoutes.size },
    'plugin routes unregistered',
  );
}

/** Every route a plugin registered, as `"METHOD /path"`, in registration
 *  order. Backs both `octomux doctor`'s counts (via `.length`) and
 *  `ctx.catalog`'s `route:METHOD /path` entries (SHR-268) — one accessor
 *  instead of a count-only export plus a separate lister. */
export function listPluginRoutes(pluginId: string): string[] {
  return Array.from(table.get(pluginId)?.keys() ?? []);
}

function toPluginRequest(req: Request, params: Record<string, string>): PluginRequest {
  return {
    params,
    query: req.query as Record<string, unknown>,
    body: req.body,
    headers: req.headers as Record<string, string | string[] | undefined>,
  };
}

function toPluginResponse(res: Response): PluginResponse {
  const pluginRes: PluginResponse = {
    status(code: number) {
      res.status(code);
      return pluginRes;
    },
    json(body: unknown) {
      res.json(body);
    },
  };
  return pluginRes;
}

/**
 * The single parent router. Mounted once at boot by `setupRoutes()` and never
 * unmounted. A path with no matching row 404s here rather than falling through
 * to the rest of the app — `/api/p/*` belongs to plugins entirely.
 *
 * Dispatch is a table lookup, not per-route Express registration: a `router.use`
 * layer contributes nothing to `server/registry/route-inventory.ts`'s walk (see
 * that file's own doc comment), which is exactly what we want — /api/p is a
 * table, not a declared surface, and the table can change shape without
 * touching Express's route stack (which express 5 can't un-mount from anyway).
 */
export function createPluginParentRouter(): Router {
  const router: Router = Router();
  router.use((req: Request, res: Response, next: NextFunction) => {
    const segments = req.path.split('/').filter(Boolean);
    const pluginId = segments[0];
    const pluginRoutes = pluginId ? table.get(pluginId) : undefined;
    if (!pluginRoutes) {
      res.status(404).json({ error: 'no such plugin route' });
      return;
    }

    const subPath = `/${segments.slice(1).join('/')}`;
    const method = req.method.toUpperCase() as HttpMethod;
    for (const entry of pluginRoutes.values()) {
      if (entry.method !== method) continue;
      const params = matchPath(entry.path, subPath);
      if (!params) continue;

      const pluginReq = toPluginRequest(req, params);
      const pluginRes = toPluginResponse(res);
      Promise.resolve()
        .then(() => entry.handler(pluginReq, pluginRes))
        .catch((err: unknown) => {
          logger.warn(
            { plugin_id: pluginId, method, path: subPath, err },
            'plugin route handler threw',
          );
          next(err);
        });
      return;
    }

    res.status(404).json({ error: 'no such plugin route' });
  });
  return router;
}

/** Test-only: clears the whole table and unfreezes the reserved-id guard. */
export function resetPluginRoutes(): void {
  table.clear();
  frozen = false;
}
