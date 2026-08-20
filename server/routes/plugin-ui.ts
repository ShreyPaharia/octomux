/**
 * Serves the `ctx.ui` contribution table to the SPA. Bindings only — no plugin
 * code crosses this boundary, which is the whole point of the declarative
 * model (see `server/plugins/ui-registry.ts`).
 *
 * Live-read on every request rather than cached: contributions appear and
 * vanish as plugins mount and unmount (SHR-254), and a cache here would be a
 * second thing to invalidate.
 */
import { Router } from 'express';
import { listUiContributions } from '../plugins/ui-registry.js';

export const router: Router = Router();

router.get('/api/plugin-ui/contributions', (_req, res) => {
  res.json({ contributions: listUiContributions() });
});
