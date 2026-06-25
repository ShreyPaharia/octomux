import express from 'express';
import type { Request, Response } from 'express';
import { listSavedFiles, getSavedFile, putSavedFile } from '../saved-files.js';
import { sendDomainError } from './_shared.js';

export const router = express.Router();

function decodeRepoPath(req: Request): string {
  return decodeURIComponent((req.params as Record<string, string>).repoPath);
}

// GET /api/repos/:repoPath/files — list saved files under .octomux/files/
router.get('/api/repos/:repoPath/files', async (req: Request, res: Response) => {
  const repoPath = decodeRepoPath(req);
  try {
    const files = await listSavedFiles(repoPath);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/repos/:repoPath/files/content?path=<rel> — read a saved file
router.get('/api/repos/:repoPath/files/content', async (req: Request, res: Response) => {
  const repoPath = decodeRepoPath(req);
  const relPath = req.query.path as string | undefined;
  if (!relPath) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }
  try {
    const file = await getSavedFile(repoPath, relPath);
    res.json(file);
  } catch (err) {
    sendDomainError(res, err);
  }
});

// PUT /api/repos/:repoPath/files/content?path=<rel> — write a saved file
router.put('/api/repos/:repoPath/files/content', async (req: Request, res: Response) => {
  const repoPath = decodeRepoPath(req);
  const relPath = req.query.path as string | undefined;
  if (!relPath) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }
  const { content } = req.body as { content?: string };
  if (content === undefined || content === null) {
    res.status(400).json({ error: 'content is required' });
    return;
  }
  try {
    const file = await putSavedFile(repoPath, relPath, content);
    res.json(file);
  } catch (err) {
    sendDomainError(res, err);
  }
});
