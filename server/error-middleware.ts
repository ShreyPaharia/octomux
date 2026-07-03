import type { Request, Response, NextFunction } from 'express';
import { BaseBranchMissingError, BaseUnavailableError } from '@octomux/diff-engine';
import { childLogger } from './logger.js';
import { ServiceError } from './services/errors.js';

const logger = childLogger('error-middleware');

function taskIdFromRequest(req: Request): string | undefined {
  const id = (req.params as Record<string, string | undefined>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function errorBody(err: ServiceError): Record<string, unknown> {
  return err.body ?? { error: err.message };
}

/** Express error-handling middleware — register last on the app. */
export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const taskId = taskIdFromRequest(req);
  const baseLog = {
    method: req.method,
    path: req.path,
    ...(taskId ? { task_id: taskId } : {}),
  };

  if (err instanceof ServiceError) {
    const level = err.status >= 500 ? 'error' : 'warn';
    logger[level]({ ...baseLog, err, status: err.status }, err.message);
    res.status(err.status).json(errorBody(err));
    return;
  }

  if (err instanceof BaseBranchMissingError) {
    logger.warn({ ...baseLog, err }, err.message);
    res.status(422).json({ error: 'base_branch_missing', message: err.message });
    return;
  }

  if (err instanceof BaseUnavailableError) {
    logger.warn({ ...baseLog, err }, err.message);
    res.status(503).json({ error: 'base_unavailable', message: err.message });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  logger.error({ ...baseLog, err }, `Unhandled error: ${message}`);
  res.status(500).json({ error: message });
}
