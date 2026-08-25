/**
 * `ctx.secrets` / `server/secrets/store.ts` HTTP surface (SHR-277).
 *
 * CORE INVARIANT: no route in this file may ever return a secret value. There
 * is no `GET /api/secrets/:name` — only metadata (`list`), write (`put`), and
 * delete. If you're adding a route here, it must not read `getSecretValue`.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { childLogger } from '../logger.js';
import { listSecrets, putSecret, deleteSecret, SECRET_NAME_RE } from '../secrets/store.js';
import { badRequest, notFound } from '../services/errors.js';

const logger = childLogger('routes/secrets');

export const router: Router = Router();

router.get('/api/secrets', (_req: Request, res: Response) => {
  res.json({ secrets: listSecrets() });
});

router.put('/api/secrets/:name', (req: Request, res: Response) => {
  const { name } = req.params as Record<string, string>;
  if (!SECRET_NAME_RE.test(name)) {
    throw badRequest(`invalid secret name: ${name}`);
  }

  const body = req.body as { value?: unknown; description?: unknown };
  if (typeof body.value !== 'string' || body.value.length === 0) {
    throw badRequest('value is required and must be a non-empty string');
  }
  if (
    body.description !== undefined &&
    body.description !== null &&
    typeof body.description !== 'string'
  ) {
    throw badRequest('description must be a string or null');
  }

  const meta = putSecret(name, body.value, body.description as string | null | undefined);
  logger.info({ name }, 'secret: written via API');
  res.json(meta);
});

router.delete('/api/secrets/:name', (req: Request, res: Response) => {
  const { name } = req.params as Record<string, string>;
  if (!SECRET_NAME_RE.test(name)) {
    throw badRequest(`invalid secret name: ${name}`);
  }

  const deleted = deleteSecret(name);
  if (!deleted) throw notFound(`Unknown secret: ${name}`);
  logger.info({ name }, 'secret: deleted via API');
  res.status(204).send();
});
