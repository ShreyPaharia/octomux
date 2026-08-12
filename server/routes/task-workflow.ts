import express from 'express';
import type { Request, Response } from 'express';
import { broadcast } from '../events.js';
import type { SummaryRequest, NoteRequest, AddRefRequest } from '../types.js';
import { fireHook, getTaskHookExecutions } from '../hook-dispatcher.js';
import {
  setCurrentSummary,
  addTaskUpdate,
  listTaskUpdates,
  getTaskExternalRefs,
  getTaskExternalRef,
  upsertTaskExternalRef,
  deleteTaskExternalRef,
} from '../repositories/index.js';
import { loadTaskOrFail, fetchTaskBundle } from './_shared.js';
import { badRequest, notFound } from '../services/errors.js';

export const router = express.Router();

// Move task to a new workflow_status
router.post('/api/tasks/:id/summary', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const body = req.body as SummaryRequest;

  if (!body.summary?.trim()) {
    throw badRequest('summary is required');
  }

  setCurrentSummary(task.id, body.summary);
  addTaskUpdate({ task_id: task.id, kind: 'summary', body: body.summary });

  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  fireHook('summary_updated', {
    event: 'summary_updated',
    task: { ...task, current_summary: body.summary },
    data: { summary: body.summary },
  });

  const updated = fetchTaskBundle(task.id);
  res.json(updated);
});

router.post('/api/tasks/:id/note', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const body = req.body as NoteRequest;

  if (!body.body?.trim()) {
    throw badRequest('body is required');
  }

  const updateId = addTaskUpdate({ task_id: task.id, kind: 'note', body: body.body });

  fireHook('note_added', {
    event: 'note_added',
    task,
    data: { body: body.body },
  });

  res.status(201).json({ id: updateId, task_id: task.id, kind: 'note', body: body.body });
});

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
