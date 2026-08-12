/**
 * server/registry/route-inventory.ts
 *
 * Walks a *built* Express app's router stack and returns the flat list of
 * `{ method, path }` pairs a client can actually reach — mount prefixes
 * resolved, so a hook route comes back as `/api/hooks/stop`, not `/stop`.
 *
 * Feeds `findUndeclaredRoutes` (server/registry/index.ts): the drift test
 * that makes "this route is not in the registry" a test failure instead of
 * a silent gap.
 *
 * Express 5 ships its router as the separate `router@2` package. Unlike
 * Express 4's Layer, `router@2`'s Layer does NOT retain the literal path a
 * `.use(path, ...)` mount call was given — `layer.path` only exists
 * transiently, set by `Layer#match()` while dispatching a real request (see
 * node_modules/router/lib/layer.js). So the *only* mounted prefixes we can
 * recover after the fact (`GET /api/hooks/stop` vs. hooks.ts's own
 * `router.post('/stop', ...)`) are ones we captured *as the mount happened*.
 *
 * We do that by wrapping `Router.prototype.use` once, at import time, so it
 * is already active before any caller can build an app that calls
 * `router.use(path, subRouter)` (e.g. `app.use('/api/hooks', hookRoutes)` in
 * server/api.ts). Terminal routes need none of this: `Route.path` (set by
 * `.get()`/`.post()`/etc.) is stored permanently on the Route object itself
 * (node_modules/router/lib/route.js), so `layer.route.path` is always
 * reliable without patching.
 */

import { Router } from 'express';
import type { Express } from 'express';
import type { HttpMethod } from './types.js';

export interface MountedRoute {
  method: HttpMethod;
  path: string;
}

const HTTP_METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

// Layer -> the literal path argument its enclosing `.use()` call was given
// ('/' when omitted). Populated by the patch below as `.use()` runs.
const mountPathByLayer = new WeakMap<object, string>();

let patched = false;

/**
 * Capture every `Router#use()` call's mount path onto the layer(s) it
 * pushes. Idempotent, and safe to call more than once (ESM only evaluates
 * this module's top level once per process, but the guard costs nothing).
 */
function patchRouterUse(): void {
  if (patched) return;
  patched = true;
  const original = Router.prototype.use;
  Router.prototype.use = function patchedUse(
    this: { stack: object[] },
    ...args: unknown[]
  ): unknown {
    const before = this.stack.length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (original as any).apply(this, args);
    const first = args[0];
    const path = typeof first === 'string' ? first : '/';
    for (let i = before; i < this.stack.length; i++) {
      mountPathByLayer.set(this.stack[i], path);
    }
    return result;
  } as typeof original;
}

// Side effect, deliberately at module load: must be active before any
// `createApp()` call that happens later in the same process (test files
// import this module before invoking `createApp()`).
patchRouterUse();

function isRouterLike(handle: unknown): handle is { stack: unknown[] } {
  return typeof handle === 'function' && Array.isArray((handle as { stack?: unknown }).stack);
}

function joinPath(prefix: string, segment: string): string {
  if (segment === '' || segment === '/') return prefix || '/';
  const trimmedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const normalizedSegment = segment.startsWith('/') ? segment : `/${segment}`;
  return `${trimmedPrefix}${normalizedSegment}`;
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle: unknown;
}

function walk(stack: RouteLayer[], prefix: string, out: MountedRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const path = joinPath(prefix, layer.route.path);
      for (const method of Object.keys(layer.route.methods)) {
        if ((HTTP_METHODS as readonly string[]).includes(method)) {
          out.push({ method: method as HttpMethod, path });
        }
      }
      continue;
    }
    if (isRouterLike(layer.handle)) {
      const mountPath = mountPathByLayer.get(layer) ?? '/';
      const nestedPrefix = joinPath(prefix, mountPath === '/' ? '' : mountPath);
      walk(layer.handle.stack as RouteLayer[], nestedPrefix, out);
    }
  }
}

/**
 * Every `{ method, path }` a client can reach on `app`, mount prefixes
 * resolved. `app` must already be built (e.g. via `createApp()`) — routers
 * mounted after this call are not visible.
 */
export function listMountedRoutes(app: Express): MountedRoute[] {
  const out: MountedRoute[] = [];
  // `app.router` (Express 5) lazily builds the top-level `router@2` Router;
  // accessing it is what `app.use`/`app.get`/etc. do internally too.
  walk((app as unknown as { router: { stack: RouteLayer[] } }).router.stack, '', out);
  return out;
}
