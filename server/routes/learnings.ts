import express from 'express';
import type { Request, Response } from 'express';
import { listLearningsForRepo, deleteLearning } from '../repositories/review-learnings.js';

export const router = express.Router();

// GET /api/repos/:repoPath/learnings — list learnings for a repo
router.get('/api/repos/:repoPath/learnings', (req: Request, res: Response) => {
  const repoPath = decodeURIComponent((req.params as Record<string, string>).repoPath);
  try {
    res.json(listLearningsForRepo(repoPath));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/learnings/:id — delete a single learning
router.delete('/api/learnings/:id', (req: Request, res: Response) => {
  const id = (req.params as Record<string, string>).id;
  try {
    deleteLearning(id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
