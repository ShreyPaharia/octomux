import express from 'express';
import type { Request, Response } from 'express';
import { listRunsForWorkflow } from '../repositories/runs.js';

export const router = express.Router();

router.get('/api/workflows/:kind/runs', (req: Request, res: Response) => {
  const { kind } = req.params as Record<string, string>;
  res.json({ runs: listRunsForWorkflow(kind) });
});
