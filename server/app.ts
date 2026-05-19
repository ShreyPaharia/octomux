import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { setupRoutes } from './api.js';
import { childLogger } from './logger.js';

const logger = childLogger('app');

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Host-header check (DNS-rebinding defense).
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      logger.warn({ host, ip: req.ip, path: req.path }, 'rejected: bad host header');
      return res.status(403).send();
    }
    next();
  });

  // CORS deny on /api/hooks/*. Browsers send Origin on all non-GET requests
  // including same-origin, so we only reject Origins whose hostname isn't a
  // loopback address. Server-to-server callers (Claude Code subprocesses) send
  // no Origin at all and pass through unaffected.
  app.use('/api/hooks', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      let hostname = '';
      try {
        hostname = new URL(origin).hostname;
      } catch {
        // Malformed Origin → treat as cross-origin
      }
      if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
        logger.warn({ origin, path: req.path }, 'rejected: cross-origin hook request');
        return res.status(403).send();
      }
    }
    next();
  });

  setupRoutes(app);

  // Error handler
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, method: req.method, path: req.path }, `Unhandled error: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return app;
}
