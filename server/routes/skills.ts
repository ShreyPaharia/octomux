import express from 'express';
import type { Request, Response } from 'express';
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill } from '../skills.js';
import { sendDomainError } from './_shared.js';

export const router = express.Router();

router.get('/api/skills', async (_req: Request, res: Response) => {
  try {
    const skills = await listSkills();
    res.json(skills);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/api/skills/:name', async (req: Request, res: Response) => {
  try {
    const skill = await getSkill(req.params.name as string);
    res.json(skill);
  } catch (err) {
    sendDomainError(res, err);
  }
});

router.post('/api/skills', async (req: Request, res: Response) => {
  const { name, content } = req.body as { name?: string; content?: string };
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    const skill = await createSkill(name, content || '');
    res.status(201).json(skill);
  } catch (err) {
    sendDomainError(res, err);
  }
});

router.put('/api/skills/:name', async (req: Request, res: Response) => {
  const { content } = req.body as { content?: string };
  if (content === undefined || content === null) {
    res.status(400).json({ error: 'content is required' });
    return;
  }
  try {
    const skill = await updateSkill(req.params.name as string, content);
    res.json(skill);
  } catch (err) {
    sendDomainError(res, err);
  }
});

router.delete('/api/skills/:name', async (req: Request, res: Response) => {
  try {
    await deleteSkill(req.params.name as string);
    res.status(204).send();
  } catch (err) {
    sendDomainError(res, err);
  }
});
