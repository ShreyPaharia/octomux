import express from 'express';
import type { Request, Response } from 'express';
import { validateAgentName } from '../harnesses/types.js';
import {
  addAgent,
  stopAgent,
  createUserTerminal,
  createShellTerminal,
  closeShellTerminal,
} from '../task-engine/index.js';
import { sendMessageToAgent } from '../tmux-input.js';
import { broadcast } from '../events.js';
import { getAgentByIdAndTask, getUserTerminalByIdAndTask } from '../repositories/index.js';
import type { AddAgentRequest } from '../types.js';
import { loadTaskOrFail } from './_shared.js';
import { badRequest, notFound } from '../services/errors.js';

export const router = express.Router();

router.post('/api/tasks/:id/agents', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  if (task.runtime_state !== 'running') {
    throw badRequest('Can only add agents to running tasks');
  }

  const body = req.body as AddAgentRequest;

  if (body.agent != null) {
    try {
      validateAgentName(body.agent);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }

  const agent = await addAgent(task, {
    prompt: body.prompt,
    agent: body.agent,
    label: body.label,
    model: body.model,
    skeleton: body.skeleton,
    notify_agent_id: body.notify_agent_id,
  });
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.status(201).json(agent);
});

router.delete('/api/tasks/:id/agents/:agentId', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const agent = getAgentByIdAndTask(req.params.agentId as string, req.params.id as string);

  if (!agent) {
    throw notFound('Task or agent not found');
  }

  await stopAgent(task, agent);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json({ success: true });
});

router.post('/api/tasks/:id/agents/:agentId/message', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  if (task.runtime_state !== 'running') {
    throw badRequest('Task is not running');
  }

  const agent = getAgentByIdAndTask(req.params.agentId as string, req.params.id as string);

  if (!agent) {
    throw notFound('Agent not found');
  }

  const { message } = req.body as { message?: string };
  if (!message) {
    throw badRequest('message is required');
  }

  await sendMessageToAgent(task.tmux_session!, agent.window_index, message);

  res.json({ success: true });
});

router.post('/api/tasks/:id/user-terminal', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  if (task.runtime_state !== 'running') {
    throw badRequest('Can only create user terminal for running tasks');
  }

  if (!task.tmux_session) {
    throw badRequest('Task has no tmux session');
  }

  const result = await createUserTerminal(task);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json(result);
});

router.post('/api/tasks/:id/terminals', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  if (task.runtime_state !== 'running') {
    throw badRequest('Can only create terminals for running tasks');
  }
  if (!task.tmux_session) {
    throw badRequest('Task has no tmux session');
  }

  const terminal = await createShellTerminal(task);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.status(201).json(terminal);
});

router.delete('/api/tasks/:id/terminals/:terminalId', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  const terminal = getUserTerminalByIdAndTask(
    req.params.terminalId as string,
    req.params.id as string,
  );

  if (!terminal) {
    throw notFound('Terminal not found');
  }

  await closeShellTerminal(task, terminal);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.status(204).send();
});
