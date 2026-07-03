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
import { badRequest, toDomainServiceError } from '../services/errors.js';

export const router = express.Router();

function repoPathFromQuery(req: Request): string | undefined {
  const repoPath = req.query.repo_path as string | undefined;
  return repoPath || undefined;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

router.get('/api/agents', async (req: Request, res: Response) => {
  const agents = await listAgents(repoPathFromQuery(req));
  res.json(agents);
});

router.get('/api/agents/:name', async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.name as string, repoPathFromQuery(req));
    res.json(agent);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});

router.put('/api/agents/:name', async (req: Request, res: Response) => {
  const { content } = req.body as { content?: string };
  if (content === undefined || content === null) {
    throw badRequest('content is required');
  }
  const repoPath = repoPathFromQuery(req);
  await saveAgent(req.params.name as string, content, repoPath);
  await syncAgents(repoPath);
  const agent = await getAgent(req.params.name as string, repoPath);
  res.json(agent);
});

router.delete('/api/agents/:name', async (req: Request, res: Response) => {
  const name = req.params.name as string;
  const repoPath = repoPathFromQuery(req);
  try {
    if (isBuiltInAgent(name)) {
      await resetAgent(name, repoPath);
    } else {
      await deleteAgent(name, repoPath);
    }
    await syncAgents(repoPath);
    res.json({ ok: true });
  } catch (err) {
    throw toDomainServiceError(err);
  }
});

router.post('/api/agents', async (req: Request, res: Response) => {
  const { name, content } = req.body as { name?: string; content?: string };
  if (!name || !content) {
    throw badRequest('name and content are required');
  }
  const repoPath = repoPathFromQuery(req);
  try {
    await createAgent(name, content, repoPath);
    await syncAgents(repoPath);
    const agent = await getAgent(name, repoPath);
    res.status(201).json(agent);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});
