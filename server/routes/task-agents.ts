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

export const router = express.Router();

// Add agent to task
router.post('/api/tasks/:id/agents', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  if (task.runtime_state !== 'running') {
    res.status(400).json({ error: 'Can only add agents to running tasks' });
    return;
  }

  const body = req.body as AddAgentRequest;

  if (body.agent != null) {
    try {
      validateAgentName(body.agent);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
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

// Stop agent
router.delete('/api/tasks/:id/agents/:agentId', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const agent = getAgentByIdAndTask(req.params.agentId as string, req.params.id as string);

  if (!agent) {
    res.status(404).json({ error: 'Task or agent not found' });
    return;
  }

  await stopAgent(task, agent);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json({ success: true });
});

// Send message to agent via tmux send-keys
router.post('/api/tasks/:id/agents/:agentId/message', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  if (task.runtime_state !== 'running') {
    res.status(400).json({ error: 'Task is not running' });
    return;
  }

  const agent = getAgentByIdAndTask(req.params.agentId as string, req.params.id as string);

  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  const { message } = req.body as { message?: string };
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  await sendMessageToAgent(task.tmux_session!, agent.window_index, message);

  res.json({ success: true });
});

// Create user terminal (lazily creates tmux window with nvim)
router.post('/api/tasks/:id/user-terminal', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  if (task.runtime_state !== 'running') {
    res.status(400).json({ error: 'Can only create user terminal for running tasks' });
    return;
  }

  if (!task.tmux_session) {
    res.status(400).json({ error: 'Task has no tmux session' });
    return;
  }

  try {
    const result = await createUserTerminal(task);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create shell terminal
router.post('/api/tasks/:id/terminals', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  if (task.runtime_state !== 'running') {
    res.status(400).json({ error: 'Can only create terminals for running tasks' });
    return;
  }
  if (!task.tmux_session) {
    res.status(400).json({ error: 'Task has no tmux session' });
    return;
  }

  try {
    const terminal = await createShellTerminal(task);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.status(201).json(terminal);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Close shell terminal
router.delete('/api/tasks/:id/terminals/:terminalId', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  const terminal = getUserTerminalByIdAndTask(
    req.params.terminalId as string,
    req.params.id as string,
  );

  if (!terminal) {
    res.status(404).json({ error: 'Terminal not found' });
    return;
  }

  try {
    await closeShellTerminal(task, terminal);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
