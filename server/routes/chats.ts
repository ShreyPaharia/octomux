import express from 'express';
import type { Request, Response } from 'express';
import { createChat, listChats, getChat, closeChat, deleteChat } from '../chats.js';
import { childLogger } from '../logger.js';
import { broadcast } from '../events.js';
import { validateAgentName } from '../harnesses/types.js';
import { getHarness } from '../harnesses/index.js';
import { hopAgent } from '../task-runner.js';
import { getAgent as getAgentRepo, getTask as getTaskRepo } from '../repositories/index.js';
import type { CreateChatRequest, Task } from '../types.js';

const apiLogger = childLogger('api');

export const router = express.Router();

router.get('/api/chats', (_req: Request, res: Response) => {
  try {
    res.json(listChats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/api/chats/:id', (req: Request, res: Response) => {
  const chat = getChat(req.params.id as string);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  res.json(chat);
});

/**
 * Move a runtime agent between task ids (or detach to a standalone chat
 * with task_id=null). Kills the old tmux window, opens a new one at the new
 * cwd, and resumes claude so transcript context survives.
 */
router.patch('/api/agents/:id/task', async (req: Request, res: Response) => {
  const agent = getAgentRepo(req.params.id as string);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const body = (req.body ?? {}) as { task_id?: string | null };
  if (!('task_id' in body)) {
    res.status(400).json({ error: 'task_id is required (string or null)' });
    return;
  }
  const targetTaskId = body.task_id;
  if (targetTaskId !== null && typeof targetTaskId !== 'string') {
    res.status(400).json({ error: 'task_id must be a string or null' });
    return;
  }
  if (targetTaskId === agent.task_id) {
    res.status(400).json({ error: 'Agent is already on that task' });
    return;
  }
  if (targetTaskId !== null) {
    const targetTask = getTaskRepo(targetTaskId);
    if (!targetTask) {
      res.status(404).json({ error: `Task not found: ${targetTaskId}` });
      return;
    }
    const trs = (targetTask as Task).runtime_state;
    if (!(['setting_up', 'running'] as const).includes(trs as 'running')) {
      res.status(409).json({ error: `Target task is not active (runtime_state=${trs})` });
      return;
    }
    if (!targetTask.worktree_id) {
      res.status(409).json({ error: 'Target task has no worktree' });
      return;
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
      res.status(409).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

router.post('/api/chats', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CreateChatRequest;

  if (body.agent != null) {
    try {
      validateAgentName(body.agent);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

  if (body.harness_id != null) {
    try {
      getHarness(body.harness_id);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

  try {
    const chat = await createChat({
      label: body.label,
      cwd: body.cwd,
      agent: body.agent,
      prompt: body.prompt,
      harnessId: body.harness_id,
    });
    res.status(201).json(chat);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Close a chat — stop the tmux session, mark the agent stopped.
 * Body: `{ status: 'stopped' }`. Preserves the row so history stays visible.
 */
router.patch('/api/chats/:id', async (req: Request, res: Response) => {
  const chat = getChat(req.params.id as string);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  const body = (req.body ?? {}) as { status?: string };
  if (body.status !== 'stopped') {
    res.status(400).json({ error: "Only status='stopped' is supported" });
    return;
  }
  try {
    await closeChat(chat);
    const updated = getChat(chat.id);
    broadcast({ type: 'chat:updated', payload: { chatId: chat.id } });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Delete a chat — kill tmux, remove scratch dir, delete DB row. */
router.delete('/api/chats/:id', async (req: Request, res: Response) => {
  const chat = getChat(req.params.id as string);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  try {
    await deleteChat(chat);
    broadcast({ type: 'chat:deleted', payload: { chatId: chat.id } });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
