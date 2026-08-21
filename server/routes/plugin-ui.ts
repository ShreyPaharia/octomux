/**
 * Serves the `ctx.ui` contribution table, the surface catalogue, and
 * per-task rendered panels to any surface (SPA, CLI, chat gateways). Bindings
 * and rendered text only — no plugin code crosses this boundary, which is
 * the whole point of the declarative model (see `server/plugins/ui-registry.ts`
 * and `server/surfaces/render.ts`).
 *
 * Live-read on every request rather than cached: contributions appear and
 * vanish as plugins mount and unmount (SHR-254), and a cache here would be a
 * second thing to invalidate.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { listUiContributions } from '../plugins/ui-registry.js';
import {
  CORE_SURFACE_KINDS,
  listSurfaces,
  contributionsForSurface,
  panelsForSurface,
} from '../surfaces/index.js';
import { ServiceError } from '../services/errors.js';
import { loadTaskOrFail } from './_shared.js';

export const router: Router = Router();

/**
 * `server/surfaces/render.ts` throws plain `Error`s with fixed messages —
 * there's no error class to switch on, so map by message prefix. Keeping
 * this in one place is what keeps all three endpoints below agreeing on the
 * mapping.
 */
function surfaceServiceError(err: unknown): ServiceError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('unknown surface ')) return new ServiceError(message, 404);
  if (message.includes('has no render')) return new ServiceError(message, 400);
  return new ServiceError(message, 500);
}

router.get('/api/plugin-ui/contributions', (req: Request, res: Response) => {
  const surfaceKind = typeof req.query.surface === 'string' ? req.query.surface : undefined;
  if (!surfaceKind) {
    res.json({ contributions: listUiContributions() });
    return;
  }
  let contributions;
  try {
    contributions = contributionsForSurface(surfaceKind);
  } catch (err) {
    throw surfaceServiceError(err);
  }
  res.json({ contributions });
});

router.get('/api/surfaces', (_req: Request, res: Response) => {
  const surfaces = listSurfaces().map((s) => ({
    kind: s.kind,
    renderers: s.renderers,
    fallback: s.fallback ?? 'json',
    canRender: typeof s.render === 'function',
    canPrompt: typeof s.prompt === 'function',
    core: (CORE_SURFACE_KINDS as readonly string[]).includes(s.kind),
  }));
  res.json({ surfaces });
});

router.get('/api/tasks/:id/panels', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const surfaceKind = typeof req.query.surface === 'string' ? req.query.surface : undefined;
  if (!surfaceKind) {
    throw new ServiceError('surface query param is required', 400);
  }
  let panels;
  try {
    panels = await panelsForSurface(surfaceKind, task.id);
  } catch (err) {
    throw surfaceServiceError(err);
  }
  res.json({ panels });
});
