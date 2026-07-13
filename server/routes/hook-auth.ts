import type { Request, Response, NextFunction } from 'express';
import { checkAgentTokenExists } from '../repositories/agent-runtime.js';
import { childLogger } from '../logger.js';

const logger = childLogger('routes/hook-auth');

/**
 * Express middleware guarding agent→server callback endpoints (the loop
 * `/emit` route, the pr-extract `/emit` route, ...). Reuses each agent's
 * per-agent `hook_token` — no separate secret per workflow.
 */
export function requireBearerHookToken(req: Request, res: Response, next: NextFunction): void {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const token = match?.[1];
  if (!token || !checkAgentTokenExists(token)) {
    logger.warn({ path: req.path, ip: req.ip }, 'hook callback: missing or invalid bearer token');
    res.status(401).send();
    return;
  }
  next();
}
