/**
 * Serves task-scoped `ctx.facts` reads to the SPA. `PluginPanels` (SHR-256)
 * needs this to resolve a panel binding's `factType` into payload data —
 * `GET /api/plugin-ui/contributions` only serves the bindings themselves,
 * never fact payloads (see `server/plugins/ui-registry.ts`).
 *
 * NOT MOUNTED YET — SHR-256 (task D) owns this file but not `server/api.ts`.
 * Controller: add
 *   import { router as pluginFactsRouter } from './routes/plugin-facts.js';
 * near the other route imports and
 *   app.use(pluginFactsRouter);
 * next to `app.use(pluginUiRouter);` in `server/api.ts`.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { readFacts } from '../plugins/facts.js';
import { loadTaskOrFail } from './_shared.js';

export const router: Router = Router();

router.get('/api/tasks/:id/facts', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const sinceSeqRaw = req.query.sinceSeq;
  const sinceSeq =
    typeof sinceSeqRaw === 'string' && sinceSeqRaw.length > 0 ? Number(sinceSeqRaw) : undefined;
  const facts = await readFacts(task.id, { type, sinceSeq });
  res.json({ facts });
});
