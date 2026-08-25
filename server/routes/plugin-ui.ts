/**
 * Serves the `ctx.ui` contribution table, the surface catalogue, rendered
 * panels — per task, and per durable collection — and, since SHR-257, the
 * action table plus the invoke path. Bindings, rendered text, and (for
 * actions) whatever JSON `run()` hands back only — no plugin code ever
 * crosses this boundary. `POST /api/plugin-ui/actions/:actionId` runs the
 * plugin's `run` function IN THE HOST process (`invokeUiAction`,
 * `server/plugins/ui-registry.ts`); the client only ever sends a qualified
 * id and a JSON payload and gets a JSON payload back.
 *
 * Live-read on every request rather than cached: contributions appear and
 * vanish as plugins mount and unmount (SHR-254), and a cache here would be a
 * second thing to invalidate.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { listUiContributions, listUiActions, invokeUiAction } from '../plugins/ui-registry.js';
import {
  CORE_SURFACE_KINDS,
  listSurfaces,
  contributionsForSurface,
  panelsForTask,
  panelsForStore,
} from '../surfaces/index.js';
import { ServiceError } from '../services/errors.js';
import { loadTaskOrFail } from './_shared.js';
import { parseCollectionQuery } from './plugin-collections.js';
import { getTask } from '../repositories/index.js';

export const router: Router = Router();

/**
 * `server/surfaces/render.ts` and `invokeUiAction` (`ui-registry.ts`) both
 * throw plain `Error`s with fixed message prefixes — there's no error class
 * to switch on, so map by prefix. Keeping this in one place is what keeps
 * every endpoint below agreeing on the mapping.
 */
function surfaceServiceError(err: unknown): ServiceError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('unknown surface ')) return new ServiceError(message, 404);
  if (message.includes('has no render')) return new ServiceError(message, 400);
  // `queryRecords` rejects an orderBy field name it can't splice into a JSON
  // path — that's a bad query string, not a server fault.
  if (message.startsWith('invalid field name')) return new ServiceError(message, 400);
  // `invokeUiAction` (SHR-257): unknown action id -> 404, schema violation -> 400.
  if (message.startsWith('unknown ui action ')) return new ServiceError(message, 404);
  if (message.startsWith('invalid input for ui action ')) return new ServiceError(message, 400);
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
    panels = await panelsForTask(surfaceKind, task.id);
  } catch (err) {
    throw surfaceServiceError(err);
  }
  res.json({ panels });
});

/**
 * The durable-store counterpart to `/api/tasks/:id/panels` (SHR-279,
 * generalized to any `ctx.records` store under SHR-282).
 *
 * A durable-store panel has no task in its binding, so it can never be
 * reached through the task route — and without this it could not be reached
 * from outside the process at all, which was exactly the bug: a panel that
 * registers, lists in `ctx.catalog`, and is drawn by nothing.
 *
 * `:name` is the QUALIFIED store name, same as `GET /api/plugin-records/:name`
 * (`server/routes/plugin-records.ts`), which serves the RAW records for the
 * SPA to draw itself. This one serves the records already rendered into a
 * surface's transport, for the surfaces that render server-side. `web` has no
 * `render` and 400s here by design — the browser is the renderer there.
 *
 * `limit`/`offset`/`orderBy`/`order` window the store exactly as they do on
 * the raw-records route; a 2,000-record board does not need every row in a
 * Slack message. Route path unchanged from its `plugin-collections` origin —
 * only the data source moved, not the URL.
 */
router.get('/api/plugin-collections/:name/panels', async (req: Request, res: Response) => {
  const surfaceKind = typeof req.query.surface === 'string' ? req.query.surface : undefined;
  if (!surfaceKind) {
    throw new ServiceError('surface query param is required', 400);
  }
  const { name } = req.params as Record<string, string>;
  let panels;
  try {
    panels = await panelsForStore(surfaceKind, name, parseCollectionQuery(req.query));
  } catch (err) {
    throw surfaceServiceError(err);
  }
  res.json({ panels });
});

/**
 * The action table (SHR-257). Ungated read, same as `/contributions` above —
 * `run` never appears in `listUiActions()`'s output, so there is nothing
 * here worth a second look.
 */
router.get('/api/plugin-ui/actions', (req: Request, res: Response) => {
  const slot = typeof req.query.slot === 'string' ? req.query.slot : undefined;
  res.json({ actions: listUiActions(slot) });
});

/**
 * Invokes one action. `:actionId` is the QUALIFIED id (`<pluginId>:<id>`);
 * express already URL-decodes route params, so a caller sends the id exactly
 * as `GET /api/plugin-ui/actions` printed it.
 *
 * `taskId`, when present, is checked against the task table — the smallest
 * correct validation, reusing the same `getTask` lookup `loadTaskOrFail`
 * wraps, rather than inventing a second helper for a body-carried id
 * `loadTaskOrFail` (params-only) can't read directly.
 */
router.post('/api/plugin-ui/actions/:actionId', async (req: Request, res: Response) => {
  const { actionId } = req.params as Record<string, string>;
  const body = (req.body ?? {}) as { taskId?: string; input?: Record<string, unknown> };

  if (body.taskId !== undefined && !getTask(body.taskId)) {
    throw new ServiceError('Task not found', 404);
  }

  let result;
  try {
    result = await invokeUiAction(actionId, { taskId: body.taskId, input: body.input });
  } catch (err) {
    throw surfaceServiceError(err);
  }
  res.json({ ok: true, message: result?.message });
});
