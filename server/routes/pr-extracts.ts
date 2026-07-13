import { Router, type Request, type Response } from 'express';
import { PR_EXTRACT_OUTPUT_SCHEMA } from '@octomux/types';
import { requireBearerHookToken } from './hook-auth.js';
import { validateAgainstSchema } from '../services/output-contract.js';
import {
  createExtract,
  getExtract,
  getExtractByTaskId,
  listExtracts,
} from '../repositories/pr-extracts.js';
import { getTask } from '../repositories/index.js';
import { badRequest, notFound, conflict } from '../services/errors.js';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import type { PrExtractRisk } from '../types.js';

const logger = childLogger('routes/pr-extracts');

export const router = Router();

router.post(
  '/api/pr-extracts/:taskId/emit',
  requireBearerHookToken,
  (req: Request, res: Response) => {
    const { taskId } = req.params as Record<string, string>;
    const task = getTask(taskId);
    if (!task) throw notFound('Task not found');
    if (!task.repo_path || task.pr_number == null || !task.pr_head_sha) {
      throw badRequest('Task has no associated PR to extract from');
    }

    const result = validateAgainstSchema('pr-extract', PR_EXTRACT_OUTPUT_SCHEMA, req.body);
    if (!result.valid) {
      throw badRequest(`Invalid pr-extract payload: ${(result.errors ?? []).join('; ')}`);
    }

    if (getExtractByTaskId(taskId)) {
      throw conflict('An extract already exists for this task');
    }

    const body = req.body as {
      area: string;
      risk: PrExtractRisk;
      has_migration: boolean;
      surface: string;
      loc: number;
    };

    const row = createExtract({
      taskId,
      repoPath: task.repo_path,
      prNumber: task.pr_number,
      prHeadSha: task.pr_head_sha,
      area: body.area,
      risk: body.risk,
      hasMigration: body.has_migration,
      surface: body.surface,
      loc: body.loc,
    });

    logger.info({ task_id: taskId, extract_id: row.id }, 'pr-extract emit recorded');
    broadcast({ type: 'pr_extract:created', payload: { taskId, extractId: row.id } });
    res.status(201).json(row);
  },
);

router.get('/api/pr-extracts', (_req: Request, res: Response) => {
  res.json(listExtracts());
});

router.get('/api/pr-extracts/:id', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const row = getExtract(id);
  if (!row) throw notFound('Extract not found');
  res.json(row);
});
