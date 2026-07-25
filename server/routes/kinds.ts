/**
 * Routes for schedule-kind presets (spec/schedule-kinds-as-presets.md §5).
 * `GET /api/schedules/kinds` (in `routes/schedules.ts`) is what the create
 * form reads; these routes are the kind *editor* — list all presets (with
 * their tier), and write/delete home-tier overrides.
 */
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { childLogger } from '../logger.js';
import { homeKindsDir } from '../octomux-paths.js';
import {
  listPresets,
  getPreset,
  checkPresetShape,
  reloadPresets,
  KIND_NAME_RE,
} from '../workflows/presets.js';
import { badRequest, notFound } from '../services/errors.js';

const logger = childLogger('routes/kinds');

export const router = express.Router();

router.get('/api/kinds', (_req: Request, res: Response) => {
  res.json({ kinds: listPresets() });
});

router.put('/api/kinds/:kind', (req: Request, res: Response) => {
  const { kind } = req.params as Record<string, string>;
  // SECURITY: validate the kind name before it ever touches the filesystem —
  // KIND_NAME_RE (^[a-z0-9][a-z0-9-]*$) cannot contain `..` or a path
  // separator, so this alone rules out traversal.
  if (!KIND_NAME_RE.test(kind)) {
    throw badRequest('kind must match ^[a-z0-9][a-z0-9-]*$');
  }

  const result = checkPresetShape(req.body, 'home', kind);
  if (!result.ok) throw badRequest(result.error);

  fs.mkdirSync(homeKindsDir(), { recursive: true });
  const file = path.join(homeKindsDir(), `${kind}.json`);
  fs.writeFileSync(file, JSON.stringify(result.preset, null, 2) + '\n', 'utf-8');
  logger.info({ kind }, 'kind: home preset written via API');

  reloadPresets();
  res.json(getPreset(kind));
});

router.delete('/api/kinds/:kind', (req: Request, res: Response) => {
  const { kind } = req.params as Record<string, string>;
  // SECURITY: same traversal guard as PUT, before any filesystem access.
  if (!KIND_NAME_RE.test(kind)) {
    throw badRequest('kind must match ^[a-z0-9][a-z0-9-]*$');
  }

  const existing = getPreset(kind);
  if (!existing) throw notFound(`Unknown kind: ${kind}`);
  if (existing.source === 'builtin') {
    throw badRequest(`"${kind}" is a built-in kind — cannot be deleted`);
  }

  const file = path.join(homeKindsDir(), `${kind}.json`);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  logger.info({ kind }, 'kind: home preset deleted via API — reveals the built-in, if any');

  reloadPresets();
  res.status(204).send();
});
