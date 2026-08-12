import express from 'express';
import type { Request, Response } from 'express';
import { listRunsForWorkflow, countRunsForWorkflow, listAllRuns } from '../repositories/runs.js';
import { listWorkflows } from '../workflows/registry.js';

export const router = express.Router();

router.get('/api/runs', (req: Request, res: Response) => {
  const { kind } = req.query as Record<string, string>;
  res.json({ runs: kind ? listRunsForWorkflow(kind) : listAllRuns() });
});

router.get('/api/workflows', (_req: Request, res: Response) => {
  res.json({
    workflows: listWorkflows().map((w) => ({
      kind: w.kind,
      displayName: w.displayName,
      surfaces: w.surfaces,
      trigger: w.trigger ?? null,
      config: w.config ?? null,
      output: w.output ?? null,
      runCount: countRunsForWorkflow(w.kind),
    })),
  });
});
