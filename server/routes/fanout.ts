/**
 * Read-only HTTP surface for `fanout_runs` / `fanout_items` (SHR-276) — what
 * makes a fan-out run legible outside a running plugin process. A DB table
 * nobody can see isn't legible; these two GET routes are.
 *
 * Deliberately no redrive route here: a redrive needs the plugin's `each`
 * handler, which is a live closure and cannot be persisted, so redrive is
 * `ctx.fanout.run({ source: { resume: runId } })` called from inside the
 * plugin. A plugin that wants a redrive button exposes one itself in three
 * lines via `ctx.http.route`.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getFanOutRun,
  listFanOutRuns,
  listFanOutItems,
  countFanOutItems,
  type FanOutRunRecord,
  type FanOutItemRecord,
} from '../repositories/fanout.js';
import { notFound } from '../services/errors.js';

export const router: Router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function toRunSummaryJson(run: FanOutRunRecord) {
  const counts = countFanOutItems(run.id);
  return {
    runId: run.id,
    name: run.name,
    status: run.status,
    total: run.total,
    succeeded: counts.done,
    dead: counts.dead,
    pending: counts.pending + counts.running,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function toItemJson(item: FanOutItemRecord) {
  return {
    key: item.key,
    status: item.status,
    attempts: item.attempts,
    item: item.item,
    ...('result' in item ? { result: item.result } : {}),
    ...('error' in item ? { error: item.error } : {}),
    updatedAt: item.updatedAt,
  };
}

router.get('/api/fanout/runs', (req: Request, res: Response) => {
  const plugin = typeof req.query.plugin === 'string' ? req.query.plugin : undefined;
  const name = typeof req.query.name === 'string' ? req.query.name : undefined;
  const parsedLimit =
    typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, parsedLimit))
    : DEFAULT_LIMIT;

  const runs = listFanOutRuns({ pluginId: plugin, name, limit });
  res.json({ runs: runs.map(toRunSummaryJson) });
});

router.get('/api/fanout/runs/:id', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const run = getFanOutRun(id);
  if (!run) throw notFound('Fan-out run not found');

  res.json({ ...toRunSummaryJson(run), items: listFanOutItems(run.id).map(toItemJson) });
});
