import express from 'express';
import type { Request, Response } from 'express';
import { createChat, listChats, getChat, closeChat, deleteChat } from '../chats.js';
import { childLogger } from '../logger.js';
import { broadcast } from '../events.js';
import { validateAgentName } from '../harnesses/types.js';
import { getHarness } from '../harnesses/index.js';
import { hopAgent } from '../task-engine/index.js';
import { getAgent as getAgentRepo, getTask as getTaskRepo } from '../repositories/index.js';
import { finishDailyPlanRunForChat } from '../workflows/daily-plan/run.js';
import type { CreateChatRequest, Task } from '../types.js';
import { badRequest, conflict, notFound, ServiceError } from '../services/errors.js';

const apiLogger = childLogger('api');

export const router = express.Router();

router.get('/api/chats', (_req: Request, res: Response) => {
  res.json(listChats());
});

router.get('/api/chats/:id', (req: Request, res: Response) => {
  const chat = getChat(req.params.id as string);
  if (!chat) {
    throw notFound('Chat not found');
  }
  res.json(chat);
});

router.patch('/api/agents/:id/task', async (req: Request, res: Response) => {
  const agent = getAgentRepo(req.params.id as string);
  if (!agent) {
    throw notFound('Agent not found');
  }
  const body = (req.body ?? {}) as { task_id?: string | null };
  if (!('task_id' in body)) {
    throw badRequest('task_id is required (string or null)');
  }
  const targetTaskId = body.task_id;
  if (targetTaskId !== null && typeof targetTaskId !== 'string') {
    throw badRequest('task_id must be a string or null');
  }
  if (targetTaskId === agent.task_id) {
    throw badRequest('Agent is already on that task');
  }
  if (targetTaskId !== null) {
    const targetTask = getTaskRepo(targetTaskId);
    if (!targetTask) {
      throw notFound(`Task not found: ${targetTaskId}`);
    }
    const trs = (targetTask as Task).runtime_state;
    if (!(['setting_up', 'running'] as const).includes(trs as 'running')) {
      throw conflict(`Target task is not active (runtime_state=${trs})`);
    }
    if (!targetTask.worktree_id) {
      throw conflict('Target task has no worktree');
    }
  }

  try {
    const updated = await hopAgent(agent, targetTaskId);
    broadcast({ type: 'task:updated', payload: { taskId: agent.task_id ?? targetTaskId ?? '' } });
    res.json(updated);
  } catch (err) {
    const msg = (err as Error).message;
    apiLogger.error(
      {
        agent_id: agent.id,
        from_task_id: agent.task_id,
        to_task_id: targetTaskId,
        operation: 'task_hop',
        err,
      },
      'task_hop: failed',
    );
    if (msg.includes('not found') || msg.includes('does not exist')) {
      throw conflict(msg);
    }
    throw new ServiceError(msg, 500);
  }
});

router.post('/api/chats', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CreateChatRequest;

  if (body.agent != null) {
    try {
      validateAgentName(body.agent);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }

  if (body.harness_id != null) {
    try {
      getHarness(body.harness_id);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }

  const chat = await createChat({
    label: body.label,
    cwd: body.cwd,
    agent: body.agent,
    prompt: body.prompt,
    harnessId: body.harness_id,
  });
  res.status(201).json(chat);
});

router.patch('/api/chats/:id', async (req: Request, res: Response) => {
  const chat = getChat(req.params.id as string);
  if (!chat) {
    throw notFound('Chat not found');
  }
  const body = (req.body ?? {}) as { status?: string };
  if (body.status !== 'stopped') {
    throw badRequest("Only status='stopped' is supported");
  }
  await closeChat(chat);
  finishDailyPlanRunForChat(chat.id); // no-op for any chat that isn't a daily-plan run
  const updated = getChat(chat.id);
  broadcast({ type: 'chat:updated', payload: { chatId: chat.id } });
  res.json(updated);
});

router.delete('/api/chats/:id', async (req: Request, res: Response) => {
  const chat = getChat(req.params.id as string);
  if (!chat) {
    throw notFound('Chat not found');
  }
  await deleteChat(chat);
  broadcast({ type: 'chat:deleted', payload: { chatId: chat.id } });
  res.status(204).send();
});
