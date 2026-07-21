/**
 * Routes for `schedule_skills` — the editable, DB-backed prompt body per cron
 * workflow kind. The DB is the sole source of truth; each kind lazily seeds
 * from the shipped SKILL.md on first read.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { childLogger } from '../logger.js';
import { upsertScheduleSkill, deleteScheduleSkill } from '../repositories/schedule-skills.js';
import {
  CRON_PROMPT_KINDS,
  isCronPromptKind,
  resolveScheduleSkillContent,
} from '../schedule-prompt.js';
import { badRequest, notFound } from '../services/errors.js';

const logger = childLogger('routes/schedule-skills');

export const router = express.Router();

router.get('/api/schedule-skills', async (_req: Request, res: Response) => {
  const skills = await Promise.all(
    CRON_PROMPT_KINDS.map(async (kind) => ({
      kind,
      content: await resolveScheduleSkillContent(kind),
    })),
  );
  res.json(skills);
});

router.put('/api/schedule-skills/:kind', (req: Request, res: Response) => {
  const { kind } = req.params as Record<string, string>;
  if (!isCronPromptKind(kind)) throw notFound(`Unknown cron kind: ${kind}`);
  const content = (req.body as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) {
    throw badRequest('content is required');
  }

  upsertScheduleSkill(kind, content);
  logger.info({ kind }, 'schedule skill updated via API');
  res.json({ kind, content });
});

router.delete('/api/schedule-skills/:kind', (req: Request, res: Response) => {
  const { kind } = req.params as Record<string, string>;
  if (!isCronPromptKind(kind)) throw notFound(`Unknown cron kind: ${kind}`);

  deleteScheduleSkill(kind);
  logger.info({ kind }, 'schedule skill reset via API');
  res.status(204).send();
});
