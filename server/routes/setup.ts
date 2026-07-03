import express from 'express';
import type { Request, Response } from 'express';
import { augmentDashboardSettings } from './_shared.js';
import { badRequest, ServiceError } from '../services/errors.js';

export const router = express.Router();

router.get('/api/setup/status', async (_req: Request, res: Response) => {
  const { getSetupStatus } = await import('../setup-status.js');
  res.json(await getSetupStatus());
});

router.post('/api/setup/install', async (req: Request, res: Response) => {
  const { id } = req.body as { id?: string };
  if (!id || typeof id !== 'string') {
    throw badRequest('body must contain { id: string }');
  }
  try {
    const { runSetupInstall } = await import('../setup-status.js');
    const result = await runSetupInstall(id);
    res.json(result);
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith('Install not allowed')) {
      throw badRequest(message);
    }
    throw new ServiceError(message, 500);
  }
});

router.post('/api/setup/apply-recommended-defaults', async (_req: Request, res: Response) => {
  const { applyRecommendedDefaults } = await import('../setup-status.js');
  const settings = await applyRecommendedDefaults();
  res.json(augmentDashboardSettings(settings));
});
