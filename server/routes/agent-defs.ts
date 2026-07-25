import express from 'express';
import type { Request, Response } from 'express';
import { listAgents, getAgent } from '../agents.js';
import { toDomainServiceError } from '../services/errors.js';

export const router = express.Router();

// ─── Agent role definitions (orchestrator/planner/reviewer plugin skeletons) ──

router.get('/api/agent-roles', async (_req: Request, res: Response) => {
  const agents = await listAgents();
  res.json(agents);
});

router.get('/api/agent-roles/:name', async (req: Request, res: Response) => {
  try {
    const agent = await getAgent(req.params.name as string);
    res.json(agent);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});
