import express from 'express';
import type { Request, Response } from 'express';
import { startTask, closeTask, resumeTask } from '../task-engine/index.js';
import { broadcast } from '../events.js';
import type { MoveTaskRequest, SummaryRequest, NoteRequest, AddRefRequest } from '../types.js';
import { WORKFLOW_STATUSES } from '../types.js';
import { fireHook, getTaskHookExecutions } from '../hook-dispatcher.js';
import {
  setRuntimeState,
  setWorkflowStatus,
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
router.post('/api/tasks/:id/move', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const body = req.body as MoveTaskRequest;

  if (!body.workflow_status || !WORKFLOW_STATUSES.includes(body.workflow_status)) {
    throw badRequest(`invalid workflow_status: ${body.workflow_status}`);
  }
  if (
    (body.workflow_status === 'human_review' || body.workflow_status === 'planned') &&
    !body.note?.trim()
  ) {
    throw badRequest(`note is required when moving to ${body.workflow_status}`);
  }

  // Close eagerly on every move to done — idle agents still hold a live claude
  // process (+MCP sidecars); reopening resumes via harness_session_id.
  if (body.workflow_status === 'done' && task.workflow_status !== 'done') {
    await closeTask(task);
  }

  const prevStatus = task.workflow_status;
  setWorkflowStatus(task.id, body.workflow_status);

  addTaskUpdate({
    task_id: task.id,
    kind: 'transition',
    from_status: prevStatus,
    to_status: body.workflow_status,
    body: body.note ?? null,
  });

  let autoStart: 'start' | 'resume' | null = null;
  if (
    body.workflow_status === 'in_progress' &&
    (task.runtime_state === 'idle' || task.runtime_state === 'error')
  ) {
    autoStart = task.worktree ? 'resume' : 'start';
  }
  if (autoStart) {
    setRuntimeState(task.id, 'setting_up', null);
  }

  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  fireHook('workflow_status_changed', {
    event: 'workflow_status_changed',
    task: {
      ...task,
      workflow_status: body.workflow_status as import('../types.js').WorkflowStatus,
    },
    data: { from: prevStatus, to: body.workflow_status, note: body.note },
  });

  const updated = fetchTaskBundle(task.id);
  res.json(updated);

  if (autoStart === 'start') {
    startTask(task)
      .then(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }))
      .catch(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }));
  } else if (autoStart === 'resume') {
    resumeTask(task)
      .then(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }))
      .catch(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }));
  }
});

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
