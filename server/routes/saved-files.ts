import express from 'express';
import type { Request, Response } from 'express';
import { listSavedFiles, getSavedFile, putSavedFile } from '../saved-files.js';
import { badRequest, toDomainServiceError } from '../services/errors.js';

export const router = express.Router();

function decodeRepoPath(req: Request): string {
  return decodeURIComponent((req.params as Record<string, string>).repoPath);
}

// GET /api/repos/:repoPath/files — list saved files under .octomux/files/
router.get('/api/repos/:repoPath/files', async (req: Request, res: Response) => {
  const repoPath = decodeRepoPath(req);
  const files = await listSavedFiles(repoPath);
  res.json(files);
});

// GET /api/repos/:repoPath/files/content?path=<rel> — read a saved file
router.get('/api/repos/:repoPath/files/content', async (req: Request, res: Response) => {
  const repoPath = decodeRepoPath(req);
  const relPath = req.query.path as string | undefined;
  if (!relPath) {
    throw badRequest('path query parameter is required');
  }
  try {
    const file = await getSavedFile(repoPath, relPath);
    res.json(file);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});

// PUT /api/repos/:repoPath/files/content?path=<rel> — write a saved file
router.put('/api/repos/:repoPath/files/content', async (req: Request, res: Response) => {
  const repoPath = decodeRepoPath(req);
  const relPath = req.query.path as string | undefined;
  if (!relPath) {
    throw badRequest('path query parameter is required');
  }
  const { content } = req.body as { content?: string };
  if (content === undefined || content === null) {
    throw badRequest('content is required');
  }
  try {
    const file = await putSavedFile(repoPath, relPath, content);
    res.json(file);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});
