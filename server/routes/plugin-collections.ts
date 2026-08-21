/**
 * Serves durable `ctx.collections` reads to the SPA (SHR-275).
 *
 * The collection analogue of `server/routes/plugin-facts.ts`. A
 * collection-bound `ctx.ui.panel()` has no task in its binding, so it cannot
 * go through `/api/tasks/:id/facts` — it resolves its records here instead.
 * There is no task in this route at all: collections are durable and
 * task-independent, so unlike `plugin-facts.ts` there's no `loadTaskOrFail`.
 *
 * `:name` is the QUALIFIED collection name (`coverage-bot:baselines`), URL
 * encoded by the client. Express decodes `req.params.name` itself (it runs
 * route params through `decodeURIComponent`), so `coverage-bot%3Abaselines`
 * arrives here as `coverage-bot:baselines` with no extra decoding needed.
 * Reads are unscoped — any plugin's collection, exactly like
 * `GET /api/tasks/:id/facts` reads any plugin's facts on that task.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { queryRecords } from '../repositories/plugin-collections.js';
import { badRequest } from '../services/errors.js';

export const router: Router = Router();

router.get(
  '/api/plugin-collections/:name',
  async (req: Request, res: Response, next: NextFunction) => {
    const { limit, offset, orderBy, order } = req.query;

    // Number('abc') is NaN and NaN never compares true, so an unparseable
    // limit/offset would silently misbehave rather than being rejected. Treat
    // anything non-finite as absent — same reasoning as `sinceSeq` in
    // `plugin-facts.ts`.
    const parsedLimit = typeof limit === 'string' && limit.length > 0 ? Number(limit) : undefined;
    const parsedOffset =
      typeof offset === 'string' && offset.length > 0 ? Number(offset) : undefined;

    const order_ = order === 'asc' || order === 'desc' ? order : undefined;

    // Express 5's `req.params` is loosely typed (see CLAUDE.md "Gotchas") —
    // this route has a single required `:name`, so it is always a string.
    const { name } = req.params as Record<string, string>;

    try {
      const records = queryRecords(name, {
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
        orderBy: typeof orderBy === 'string' ? orderBy : undefined,
        order: order_,
      });
      res.json({ records });
    } catch (err) {
      // queryRecords throws on an invalid orderBy field name — a bad field
      // name from a query string is a client error, not a server fault.
      next(badRequest(err instanceof Error ? err.message : String(err)));
    }
  },
);
