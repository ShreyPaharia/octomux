import express from 'express';
import type { Request, Response } from 'express';
import { listAgents, getAgent } from '../agents.js';
import { toDomainServiceError } from '../services/errors.js';

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
