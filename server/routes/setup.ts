import express from 'express';
import type { Request, Response } from 'express';
import { augmentDashboardSettings } from './_shared.js';

export const router = express.Router();

router.get('/api/setup/status', async (_req: Request, res: Response) => {
  try {
    const { getSetupStatus } = await import('../setup-status.js');
    res.json(await getSetupStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/api/setup/install', async (req: Request, res: Response) => {
  const { id } = req.body as { id?: string };
  if (!id || typeof id !== 'string') {
    res.status(400).json({ error: 'body must contain { id: string }' });
    return;
  }
  try {
    const { runSetupInstall } = await import('../setup-status.js');
    const result = await runSetupInstall(id);
    res.json(result);
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith('Install not allowed')) {
      res.status(400).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
});

router.post('/api/setup/apply-recommended-defaults', async (_req: Request, res: Response) => {
  try {
    const { applyRecommendedDefaults } = await import('../setup-status.js');
    const settings = await applyRecommendedDefaults();
    res.json(augmentDashboardSettings(settings));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
