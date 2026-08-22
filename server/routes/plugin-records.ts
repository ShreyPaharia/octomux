/**
 * Serves `ctx.records` reads to the SPA (SHR-282 — replaces
 * `server/routes/plugin-facts.ts` and takes over the client-facing half of
 * `server/routes/plugin-collections.ts`, which read from the now-defunct
 * `plugin_collections` table). `PluginPanels` needs this to resolve a panel
 * binding's `recordStore` into payload data — `GET /api/plugin-ui/contributions`
 * only serves the bindings themselves, never record payloads (see
 * `server/plugins/ui-registry.ts`).
 *
 * Two routes, mirroring the two render entry points in `server/surfaces/render.ts`:
 *
 * - `GET /api/tasks/:id/records` — task-scoped, like the old `/facts` route.
 *   Reads are scoped to `taskId`, so a durable store's rows (all `taskId: null`)
 *   never surface here — no separate branch needed to keep them out.
 * - `GET /api/plugin-records/:name` — unscoped, like the old
 *   `/api/plugin-collections/:name`. `:name` is the QUALIFIED store name.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { readRecordsForTask, queryRecords } from '../repositories/plugin-records.js';
import { toEnvelope } from '../plugins/records.js';
import { loadTaskOrFail } from './_shared.js';
import { parseCollectionQuery } from './plugin-collections.js';
import { badRequest } from '../services/errors.js';

export const router: Router = Router();

router.get('/api/tasks/:id/records', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const store = typeof req.query.store === 'string' ? req.query.store : undefined;
  const sinceSeqRaw = req.query.sinceSeq;
  // Number('abc') is NaN and `seq > NaN` is false for every row, so an
  // unparseable sinceSeq would silently return zero records rather than
  // being rejected. Treat anything non-finite as absent.
  const parsedSinceSeq =
    typeof sinceSeqRaw === 'string' && sinceSeqRaw.length > 0 ? Number(sinceSeqRaw) : undefined;
  const sinceSeq = Number.isFinite(parsedSinceSeq) ? parsedSinceSeq : undefined;
  const rows = readRecordsForTask(task.id, store).filter(
    (r) => sinceSeq === undefined || r.seq > sinceSeq,
  );
  res.json({ records: rows.map(toEnvelope) });
});

router.get('/api/plugin-records/:name', async (req: Request, res: Response, next: NextFunction) => {
  // Express 5's `req.params` is loosely typed (see CLAUDE.md "Gotchas") —
  // this route has a single required `:name`, so it is always a string.
  const { name } = req.params as Record<string, string>;

  try {
    const rows = queryRecords(name, parseCollectionQuery(req.query));
    res.json({ records: rows.map(toEnvelope) });
  } catch (err) {
    // queryRecords throws on an invalid orderBy field name — a bad field
    // name from a query string is a client error, not a server fault.
    next(badRequest(err instanceof Error ? err.message : String(err)));
  }
});
