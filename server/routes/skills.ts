import express from 'express';
import type { Request, Response } from 'express';
import { listSkills, getSkill, type SkillsOptions } from '../skills.js';
import { toDomainServiceError } from '../services/errors.js';

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
