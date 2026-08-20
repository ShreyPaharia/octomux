/**
 * Serves task-scoped `ctx.facts` reads to the SPA. `PluginPanels` (SHR-256)
 * needs this to resolve a panel binding's `factType` into payload data —
 * `GET /api/plugin-ui/contributions` only serves the bindings themselves,
 * never fact payloads (see `server/plugins/ui-registry.ts`).
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
  // Number('abc') is NaN and `seq > NaN` is false for every row, so an
  // unparseable sinceSeq would silently return zero facts rather than being
  // rejected. Treat anything non-finite as absent.
  const parsedSinceSeq =
    typeof sinceSeqRaw === 'string' && sinceSeqRaw.length > 0 ? Number(sinceSeqRaw) : undefined;
  const sinceSeq = Number.isFinite(parsedSinceSeq) ? parsedSinceSeq : undefined;
  const facts = await readFacts(task.id, { type, sinceSeq });
  res.json({ facts });
});
