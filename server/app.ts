import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setupRoutes } from './api.js';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  setupRoutes(app);

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  });

  return app;
}
