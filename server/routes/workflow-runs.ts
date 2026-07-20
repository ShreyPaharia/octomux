import express from 'express';
import type { Request, Response } from 'express';
import { listRunsForWorkflow, countRunsForWorkflow, listAllRuns } from '../repositories/runs.js';
import { listWorkflows } from '../workflows/registry.js';

export const router = express.Router();

router.get('/api/runs', (_req: Request, res: Response) => {
  res.json({ runs: listAllRuns() });
});

router.get('/api/workflows', (_req: Request, res: Response) => {
  res.json({
    workflows: listWorkflows().map((w) => ({
      kind: w.kind,
      displayName: w.displayName,
      surfaces: w.surfaces,
      trigger: w.trigger ?? null,
      output: w.output ?? null,
      runCount: countRunsForWorkflow(w.kind),
    })),
  });
});

router.get('/api/workflows/:kind/runs', (req: Request, res: Response) => {
  const { kind } = req.params as Record<string, string>;
  res.json({ runs: listRunsForWorkflow(kind) });
});
