import express from 'express';
import { setupRoutes } from './api.js';
import { errorMiddleware } from './error-middleware.js';
import { childLogger } from './logger.js';
import { registerAuthRoutes, remoteAuthMiddleware, isRemoteMode } from './remote-auth.js';

const logger = childLogger('app');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

function isHostAllowed(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (!isRemoteMode()) return false;
  const allowed = (process.env.OCTOMUX_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (allowed.includes(host)) return true;
  // Tailscale CGNAT range 100.64.0.0/10
  const m = host.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const second = Number(m[1]);
    if (second >= 64 && second <= 127) return true;
  }
  return false;
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Host-header check (DNS-rebinding defense). In remote mode, also allow
  // configured Tailscale hosts and the 100.64.0.0/10 tailnet range.
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (!isHostAllowed(host)) {
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

  registerAuthRoutes(app);
  app.use(remoteAuthMiddleware);

  setupRoutes(app);

  app.use(errorMiddleware);

  return app;
}
