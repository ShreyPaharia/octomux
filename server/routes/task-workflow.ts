import express from 'express';
import type { Request, Response } from 'express';
import type { AddRefRequest } from '../types.js';
import { fireHook, getTaskHookExecutions } from '../hook-dispatcher.js';
import {
  listTaskUpdates,
  getTaskExternalRefs,
  getTaskExternalRef,
  upsertTaskExternalRef,
  deleteTaskExternalRef,
} from '../repositories/index.js';
import { loadTaskOrFail } from './_shared.js';
import { badRequest, notFound } from '../services/errors.js';

export const router = express.Router();

// POST /api/tasks/:id/summary and POST /api/tasks/:id/note retired (spec
// §5.5): the narrative they wrote now lives in the task's
// `.octomux/artifact.md` (see server/artifact.ts). The one remaining
// summary writer (server/summarize.ts, server/hooks.ts post-tool-use) calls
// setTaskSummary() directly — there is no HTTP surface left for it. Note-
// adding has no replacement in this pass (see report); 'note_added' is
// deprecated in server/routes/hooks-registry.ts accordingly.

router.post('/api/tasks/:id/refs', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const body = req.body as AddRefRequest & { metadata?: unknown };

  if (!body.integration?.trim()) {
    throw badRequest('integration is required');
  }
  if (!body.ref?.trim()) {
    throw badRequest('ref is required');
  }
  if (
    body.metadata !== undefined &&
    body.metadata !== null &&
    (typeof body.metadata !== 'object' || Array.isArray(body.metadata))
  ) {
    throw badRequest('metadata must be a JSON object');
  }

  const result = upsertTaskExternalRef({
    task_id: task.id,
    integration: body.integration,
    ref: body.ref,
    url: body.url ?? null,
    metadata:
      body.metadata !== null &&
      body.metadata !== undefined &&
      typeof body.metadata === 'object' &&
      !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : null,
  });

  fireHook('ref_added', {
    event: 'ref_added',
    task,
    data: { integration: body.integration, ref: body.ref, url: body.url },
  });

  res.status(201).json(result);
});

router.delete('/api/tasks/:id/refs/:integration', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const integration = (req.params as Record<string, string>).integration;

  const existing = getTaskExternalRef(task.id, integration);
  if (!existing) {
    throw notFound('Ref not found');
  }

  deleteTaskExternalRef(task.id, integration);

  fireHook('ref_removed', {
    event: 'ref_removed',
    task,
    data: { integration },
  });

  res.status(204).send();
});

router.get('/api/tasks/:id/updates', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const limitRaw = Number(req.query.limit ?? 100);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 1000);

  const updates = listTaskUpdates(task.id, limit);
  res.json(updates);
});

router.get('/api/tasks/:id/refs', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  res.json(getTaskExternalRefs(task.id));
});

router.get('/api/tasks/:id/hooks', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
  const executions = getTaskHookExecutions(task.id, limit);
  res.json(executions);
});
