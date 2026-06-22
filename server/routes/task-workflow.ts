import express from 'express';
import type { Request, Response } from 'express';
import { startTask, closeTask, resumeTask } from '../task-runner.js';
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

export const router = express.Router();

// Move task to a new workflow_status
router.post('/api/tasks/:id/move', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const body = req.body as MoveTaskRequest;

  if (!body.workflow_status || !WORKFLOW_STATUSES.includes(body.workflow_status)) {
    res.status(400).json({ error: `invalid workflow_status: ${body.workflow_status}` });
    return;
  }
  if (
    (body.workflow_status === 'human_review' || body.workflow_status === 'planned') &&
    !body.note?.trim()
  ) {
    res.status(400).json({ error: `note is required when moving to ${body.workflow_status}` });
    return;
  }

  // Auto-close runtime when moving to the terminal column (done) if
  // the task is still actively running. Keeps the worktree/branch (close, not delete).
  if (
    body.workflow_status === 'done' &&
    (task.runtime_state === 'running' || task.runtime_state === 'setting_up')
  ) {
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

  // Auto-start: moving to in_progress should kick the task into setting_up
  // if it isn't already running. Mirrors POST /api/tasks/:id/start and the
  // resume branch of PATCH /api/tasks/:id, but triggered by a board move.
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

  // Fire-and-forget after responding so the client gets the optimistic
  // setting_up state immediately and a follow-up task:updated broadcast
  // surfaces success or error.
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

// Post a summary for a task
router.post('/api/tasks/:id/summary', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const body = req.body as SummaryRequest;

  if (!body.summary?.trim()) {
    res.status(400).json({ error: 'summary is required' });
    return;
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

// Add a note to a task
router.post('/api/tasks/:id/note', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const body = req.body as NoteRequest;

  if (!body.body?.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }

  const updateId = addTaskUpdate({ task_id: task.id, kind: 'note', body: body.body });

  fireHook('note_added', {
    event: 'note_added',
    task,
    data: { body: body.body },
  });

  res.status(201).json({ id: updateId, task_id: task.id, kind: 'note', body: body.body });
});

// Add/replace an external ref
router.post('/api/tasks/:id/refs', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const body = req.body as AddRefRequest & { metadata?: unknown };

  if (!body.integration?.trim()) {
    res.status(400).json({ error: 'integration is required' });
    return;
  }
  if (!body.ref?.trim()) {
    res.status(400).json({ error: 'ref is required' });
    return;
  }
  if (
    body.metadata !== undefined &&
    body.metadata !== null &&
    (typeof body.metadata !== 'object' || Array.isArray(body.metadata))
  ) {
    res.status(400).json({ error: 'metadata must be a JSON object' });
    return;
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

// Delete an external ref
router.delete('/api/tasks/:id/refs/:integration', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const integration = (req.params as Record<string, string>).integration;

  const existing = getTaskExternalRef(task.id, integration);
  if (!existing) {
    res.status(404).json({ error: 'Ref not found' });
    return;
  }

  deleteTaskExternalRef(task.id, integration);

  fireHook('ref_removed', {
    event: 'ref_removed',
    task,
    data: { integration },
  });

  res.status(204).send();
});

// Get task updates (timeline)
router.get('/api/tasks/:id/updates', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const limitRaw = Number(req.query.limit ?? 100);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 1000);

  const updates = listTaskUpdates(task.id, limit);
  res.json(updates);
});

// Get task external refs
router.get('/api/tasks/:id/refs', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  res.json(getTaskExternalRefs(task.id));
});

// ─── Hook executions for a task ──────────────────────────────────────────────
router.get('/api/tasks/:id/hooks', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
  const executions = getTaskHookExecutions(task.id, limit);
  res.json(executions);
});
