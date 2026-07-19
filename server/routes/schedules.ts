import express from 'express';
import type { Request, Response } from 'express';
import { childLogger } from '../logger.js';
import {
  listSchedules,
  getSchedule,
  upsertSchedule,
  updateSchedule,
  deleteSchedule,
} from '../repositories/schedules.js';
import { listScheduleKinds } from '../schedules/handlers.js';
import { listTasksBySchedule } from '../repositories/tasks.js';
import { badRequest, notFound } from '../services/errors.js';

const logger = childLogger('routes/schedules');

export const router = express.Router();

// NOTE: registered before '/api/schedules/:id' — Express matches routes in
// declaration order, so the literal 'kinds' segment must win over the :id param.
router.get('/api/schedules/kinds', (_req: Request, res: Response) => {
  res.json({ kinds: listScheduleKinds() });
});

router.get('/api/schedules', (_req: Request, res: Response) => {
  res.json(listSchedules());
});

router.post('/api/schedules', (req: Request, res: Response) => {
  const body = req.body as {
    kind?: unknown;
    repoPath?: unknown;
    cron?: unknown;
    enabled?: unknown;
    config?: unknown;
  };

  if (typeof body.kind !== 'string' || !listScheduleKinds().includes(body.kind)) {
    throw badRequest(`kind must be one of: ${listScheduleKinds().join(', ')}`);
  }
  if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
    throw badRequest('repoPath is required');
  }
  if (typeof body.cron !== 'string' || !body.cron.trim()) {
    throw badRequest('cron is required');
  }

  const row = upsertSchedule({
    kind: body.kind,
    repoPath: body.repoPath,
    cron: body.cron,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    config: body.config as Record<string, unknown> | undefined,
  });

  logger.info({ schedule_id: row.id, kind: row.kind }, 'schedule: created via API');
  res.status(201).json(row);
});

router.patch('/api/schedules/:id', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const body = req.body as { cron?: unknown; enabled?: unknown; config?: unknown };

  if (body.cron !== undefined && (typeof body.cron !== 'string' || !body.cron.trim())) {
    throw badRequest('cron must be a non-empty string');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw badRequest('enabled must be a boolean');
  }

  const updated = updateSchedule(id, {
    cron: body.cron as string | undefined,
    enabled: body.enabled as boolean | undefined,
    config: body.config as Record<string, unknown> | undefined,
  });
  if (!updated) throw notFound('Schedule not found');

  res.json(updated);
});

router.delete('/api/schedules/:id', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  if (!getSchedule(id)) throw notFound('Schedule not found');

  deleteSchedule(id);
  res.status(204).send();
});

router.get('/api/schedules/:id/runs', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  if (!getSchedule(id)) throw notFound('Schedule not found');

  res.json({ runs: listTasksBySchedule(id) });
});
