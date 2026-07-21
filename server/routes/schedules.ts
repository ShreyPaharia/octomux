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
import { listRunsForSchedule } from '../repositories/runs.js';
import { getWorkflow, listCronWorkflowKinds } from '../workflows/registry.js';
import { validateWorkflowConfig } from '../workflows/config.js';
import { executeScheduleRun } from '../poller/execute-schedule-run.js';
import { badRequest, notFound, ServiceError } from '../services/errors.js';

const logger = childLogger('routes/schedules');

export const router = express.Router();

function assertCronKind(kind: string): void {
  if (!listCronWorkflowKinds().includes(kind)) {
    throw badRequest(`kind must be one of: ${listCronWorkflowKinds().join(', ')}`);
  }
}

function validateScheduleConfig(kind: string, config: unknown): void {
  const wf = getWorkflow(kind);
  if (!wf) throw badRequest(`unknown workflow kind: ${kind}`);
  if (config === undefined) return;
  const result = validateWorkflowConfig(wf, config);
  if (!result.valid) {
    throw new ServiceError('config validation failed', 400, {
      error: 'config validation failed',
      details: result.errors,
    });
  }
}

// NOTE: registered before '/api/schedules/:id' — Express matches routes in
// declaration order, so the literal 'kinds' segment must win over the :id param.
router.get('/api/schedules/kinds', (_req: Request, res: Response) => {
  res.json({
    kinds: listCronWorkflowKinds().map((kind) => {
      const wf = getWorkflow(kind)!;
      return {
        kind: wf.kind,
        displayName: wf.displayName,
        configSchema: wf.config ?? null,
      };
    }),
  });
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

  if (typeof body.kind !== 'string') {
    throw badRequest('kind is required');
  }
  assertCronKind(body.kind);
  if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
    throw badRequest('repoPath is required');
  }
  if (typeof body.cron !== 'string' || !body.cron.trim()) {
    throw badRequest('cron is required');
  }
  validateScheduleConfig(body.kind, body.config);

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
  const body = req.body as {
    cron?: unknown;
    enabled?: unknown;
    config?: unknown;
  };

  if (body.cron !== undefined && (typeof body.cron !== 'string' || !body.cron.trim())) {
    throw badRequest('cron must be a non-empty string');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw badRequest('enabled must be a boolean');
  }

  const existing = getSchedule(id);
  if (!existing) throw notFound('Schedule not found');
  if (body.config !== undefined) {
    validateScheduleConfig(existing.kind, body.config);
  }

  const updated = updateSchedule(id, {
    cron: body.cron as string | undefined,
    enabled: body.enabled as boolean | undefined,
    config: body.config as Record<string, unknown> | undefined,
  });
  if (!updated) throw notFound('Schedule not found');

  res.json(updated);
});

router.post('/api/schedules/:id/run', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  if (!getSchedule(id)) throw notFound('Schedule not found');

  await executeScheduleRun(id, { trigger: 'manual' });
  res.status(202).json({ ok: true });
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

  res.json({ runs: listRunsForSchedule(id) });
});
