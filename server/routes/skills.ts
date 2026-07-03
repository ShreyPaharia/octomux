import express from 'express';
import type { Request, Response } from 'express';
import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  type SkillsOptions,
} from '../skills.js';
import { badRequest, toDomainServiceError } from '../services/errors.js';

export const router = express.Router();

function skillsOpts(req: Request): SkillsOptions | undefined {
  const repoPath = req.query.repo_path as string | undefined;
  return repoPath ? { repoPath } : undefined;
}

router.get('/api/skills', async (req: Request, res: Response) => {
  const skills = await listSkills(skillsOpts(req));
  res.json(skills);
});

router.get('/api/skills/:name', async (req: Request, res: Response) => {
  try {
    const skill = await getSkill(req.params.name as string, skillsOpts(req));
    res.json(skill);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});

router.post('/api/skills', async (req: Request, res: Response) => {
  const { name, content } = req.body as { name?: string; content?: string };
  if (!name) {
    throw badRequest('name is required');
  }
  try {
    const skill = await createSkill(name, content || '', skillsOpts(req));
    res.status(201).json(skill);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});

router.put('/api/skills/:name', async (req: Request, res: Response) => {
  const { content } = req.body as { content?: string };
  if (content === undefined || content === null) {
    throw badRequest('content is required');
  }
  try {
    const skill = await updateSkill(req.params.name as string, content, skillsOpts(req));
    res.json(skill);
  } catch (err) {
    throw toDomainServiceError(err);
  }
});

router.delete('/api/skills/:name', async (req: Request, res: Response) => {
  try {
    await deleteSkill(req.params.name as string, skillsOpts(req));
    res.status(204).send();
  } catch (err) {
    throw toDomainServiceError(err);
  }
});
