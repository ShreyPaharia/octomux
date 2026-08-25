/**
 * Serves task-scoped `ctx.artifacts` files to the SPA (and anything else
 * that wants a plugin-written artifact over HTTP). Sibling of
 * `server/routes/plugin-records.ts` — same shape, same task-scoped/unscoped-
 * across-plugins read model as `ctx.records`, but for files instead of typed
 * payloads. See `server/artifact-files.ts` for the on-disk format and
 * `server/artifact-task.ts` for the taskId-resolving wrapper this route calls.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { listTaskArtifacts, readTaskArtifact, toArtifactEntry } from '../artifact-task.js';
import { notFound } from '../services/errors.js';
import { loadTaskOrFail } from './_shared.js';

export const router: Router = Router();

// Mime types safe to render inline in the browser. Anything else is forced to
// download rather than render same-origin — see the comment on the content
// route below for why.
const RENDER_SAFE_MIMES = new Set(['text/plain', 'text/markdown', 'application/json', 'text/csv']);

router.get('/api/tasks/:id/artifacts', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const artifacts = listTaskArtifacts(task.id).map((r) => toArtifactEntry(task.id, r));
  res.json({ artifacts });
});

router.get('/api/tasks/:id/artifacts/:pluginId/:name', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  // `:pluginId` and `:name` are attacker-controlled path segments and are NOT
  // sanitized here. `readTaskArtifact` -> `readArtifact` looks them up as an
  // exact key in the task's `index.json` (itself only ever populated by
  // `writeArtifact`, which validates both segments against a strict
  // `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` charset before writing) and additionally
  // re-checks path containment before touching disk. A miss — including any
  // `..`/`/`-shaped segment, which can never match a stored key — returns
  // `null`, which this route turns into a 404. Do not assume this route is
  // the guard; it isn't, `artifact-files.ts` is.
  const found = readTaskArtifact(task.id, req.params.pluginId as string, req.params.name as string);
  if (!found) {
    throw notFound('Artifact not found');
  }

  // A plugin's declared `mime` is attacker-influenced content (the plugin
  // runs in-process, but the browser is a separate blast radius from
  // there — see CLAUDE.md's plugin trust-model note). Serving an arbitrary
  // plugin-declared `text/html` (or `image/svg+xml`, which can carry
  // <script>) body inline, same-origin, is a stored-XSS vector into the
  // dashboard: a malicious/compromised plugin writes an artifact, a user
  // opens its URL, and it executes as the dashboard's origin. Rather than
  // special-casing the couple of dangerous mimes, force anything outside a
  // small render-safe allowlist to download instead of render.
  res.set('X-Content-Type-Options', 'nosniff');
  if (!RENDER_SAFE_MIMES.has(found.record.mime)) {
    res.set('Content-Disposition', 'attachment');
  }
  res.type(found.record.mime).send(found.body);
});
