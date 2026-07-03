import express from 'express';
import type { Request, Response } from 'express';
import { listLearningsForRepo, deleteLearning } from '../repositories/review-learnings.js';

export const router = express.Router();

// GET /api/repos/:repoPath/learnings — list learnings for a repo
router.get('/api/repos/:repoPath/learnings', (req: Request, res: Response) => {
  const repoPath = decodeURIComponent((req.params as Record<string, string>).repoPath);
  res.json(listLearningsForRepo(repoPath));
});

// DELETE /api/learnings/:id — delete a single learning
router.delete('/api/learnings/:id', (req: Request, res: Response) => {
  const id = (req.params as Record<string, string>).id;
  deleteLearning(id);
  res.status(204).send();
});
