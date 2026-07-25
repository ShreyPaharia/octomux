import express from 'express';
import type { Request, Response } from 'express';
import { listSkills, getSkill } from '../skills.js';
import { toDomainServiceError } from '../services/errors.js';

export const router = express.Router();

router.get('/api/skills', async (_req: Request, res: Response) => {
  const skills = await listSkills();
  res.json(skills);
});

router.get('/api/skills/:name', async (req: Request, res: Response) => {
  try {
    const skill = await getSkill(req.params.name as string);
    res.json(skill);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});
