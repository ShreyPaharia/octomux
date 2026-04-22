import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setupRoutes } from './api.js';
import { childLogger } from './logger.js';

const logger = childLogger('app');

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  setupRoutes(app);

  // Error handler
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, method: req.method, path: req.path }, `Unhandled error: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return app;
}
