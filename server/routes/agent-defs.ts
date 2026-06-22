import express from 'express';
import type { Request, Response } from 'express';
import {
  listAgents,
  getAgent,
  saveAgent,
  resetAgent,
  createAgent,
  deleteAgent,
  isBuiltInAgent,
  syncAgents,
} from '../agents.js';
import { sendDomainError } from './_shared.js';

export const router = express.Router();

// ─── Agents ──────────────────────────────────────────────────────────────────

router.get('/api/agents', async (_req: Request, res: Response) => {
  try {
    const agents = await listAgents();
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/api/agents/:name', async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.name as string);
    res.json(agent);
  } catch (err) {
    sendDomainError(res, err);
  }
});

router.put('/api/agents/:name', async (req: Request, res: Response) => {
  const { content } = req.body as { content?: string };
  if (content === undefined || content === null) {
    res.status(400).json({ error: 'content is required' });
    return;
  }
  try {
    await saveAgent(req.params.name as string, content);
    await syncAgents();
    const agent = await getAgent(req.params.name as string);
    res.json(agent);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete('/api/agents/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    if (isBuiltInAgent(name)) {
      await resetAgent(name);
    } else {
      await deleteAgent(name);
    }
    await syncAgents();
    res.json({ ok: true });
  } catch (err) {
    sendDomainError(res, err);
  }
});

router.post('/api/agents', async (req: Request, res: Response) => {
  const { name, content } = req.body as { name?: string; content?: string };
  if (!name || !content) {
    res.status(400).json({ error: 'name and content are required' });
    return;
  }
  try {
    await createAgent(name, content);
    await syncAgents();
    const agent = await getAgent(name);
    res.status(201).json(agent);
  } catch (err) {
    sendDomainError(res, err);
  }
});
