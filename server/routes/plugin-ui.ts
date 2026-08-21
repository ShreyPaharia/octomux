/**
 * Serves the `ctx.ui` contribution table, the surface catalogue, and
 * rendered panels — per task, and per durable collection — to any surface
 * (SPA, CLI, chat gateways). Bindings and rendered text only — no plugin code
 * crosses this boundary, which is the whole point of the declarative model
 * (see `server/plugins/ui-registry.ts` and `server/surfaces/render.ts`).
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
  renderCollectionPanels,
} from '../surfaces/index.js';
import { ServiceError } from '../services/errors.js';
import { loadTaskOrFail } from './_shared.js';
import { parseCollectionQuery } from './plugin-collections.js';

export const router: Router = Router();

/**
 * `server/surfaces/render.ts` throws plain `Error`s with fixed messages —
 * there's no error class to switch on, so map by message prefix. Keeping
 * this in one place is what keeps all four endpoints below agreeing on the
 * mapping.
 */
function surfaceServiceError(err: unknown): ServiceError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('unknown surface ')) return new ServiceError(message, 404);
  if (message.includes('has no render')) return new ServiceError(message, 400);
  // `queryRecords` rejects an orderBy field name it can't splice into a JSON
  // path — that's a bad query string, not a server fault.
  if (message.startsWith('invalid field name')) return new ServiceError(message, 400);
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

/**
 * The collection-bound counterpart to `/api/tasks/:id/panels` (SHR-279).
 *
 * A collection-bound panel has no task in its binding, so it can never be
 * reached through the task route — and without this it could not be reached
 * from outside the process at all, which was exactly the bug: a panel that
 * registers, lists in `ctx.catalog`, and is drawn by nothing.
 *
 * `:name` is the QUALIFIED collection name, same as
 * `GET /api/plugin-collections/:name`, which serves the RAW records for the
 * SPA to draw itself. This one serves the records already rendered into a
 * surface's transport, for the surfaces that render server-side. `web` has no
 * `render` and 400s here by design — the browser is the renderer there.
 *
 * `limit`/`offset`/`orderBy`/`order` window the collection exactly as they do
 * on the raw-records route; a 2,000-record board does not need every row in a
 * Slack message.
 */
router.get('/api/plugin-collections/:name/panels', async (req: Request, res: Response) => {
  const surfaceKind = typeof req.query.surface === 'string' ? req.query.surface : undefined;
  if (!surfaceKind) {
    throw new ServiceError('surface query param is required', 400);
  }
  const { name } = req.params as Record<string, string>;
  let panels;
  try {
    panels = await renderCollectionPanels(surfaceKind, name, parseCollectionQuery(req.query));
  } catch (err) {
    throw surfaceServiceError(err);
  }
  res.json({ panels });
});
