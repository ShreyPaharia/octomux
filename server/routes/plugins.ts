/**
 * Plugin admin surface — currently just the explicit reload behind
 * `octomux plugins reload <id>` (SHR-254).
 *
 * Deliberately a router mounted through `server/api.ts`, not an `app.post()` in
 * `server/index.ts`. A route registered on `app` after `createApp()` returns is
 * invisible to `server/registry/route-inventory.ts`, whose whole job is to fail
 * when a handler exists that nobody declared — so a route added there ships to
 * production with the drift test structurally unable to see it. The boot-order
 * contract only constrains `loadPlugins()`, which must run before
 * `createApp()` snapshots the workflow registry; nothing about this route does.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { reloadPlugin } from '../plugins/loader.js';
import { manifestPath, pluginModulesDir } from '../plugins/paths.js';

export const router: Router = Router();

router.post('/api/plugins/:id/reload', async (req: Request, res: Response) => {
  const result = await reloadPlugin({
    manifestPath: manifestPath(),
    resolveFrom: pluginModulesDir(),
    id: req.params.id as string,
  });
  if (!result.ok) {
    // 409, not 400, when the plugin is structurally unloadable (it declared an
    // apiRouter): the request was well-formed and retrying it verbatim will
    // never succeed until the plugin migrates off `apiRouter`.
    res.status(result.unloadable === false ? 409 : 400).json(result);
    return;
  }
  res.json(result);
});
