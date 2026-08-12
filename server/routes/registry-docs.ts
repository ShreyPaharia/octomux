/**
 * Generic router for octomux's built-in, read-only named documents: skills
 * (`GET /api/skills`, `GET /api/skills/:name`) and agent role definitions
 * (`GET /api/agent-roles`, `GET /api/agent-roles/:name`). Both are a plain
 * list + get-by-name over a single tier of files bundled with the octomux
 * plugin — see `../skills.js` / `../agents.js` for the name-validation and
 * file-reading logic; this module only wires that up to HTTP.
 *
 * `kinds.ts` and `saved-files.ts` are deliberately NOT folded into this
 * factory: `kinds` adds a write/delete path with its own body-shape
 * validation (`checkPresetShape`) and a two-tier (builtin/home)
 * reveal-on-delete rule, and `saved-files` is repo-scoped with a query-param
 * path identifier (nested subpaths, not a flat name) and different security
 * checks (extension allowlist, symlink detection, traversal guard against a
 * repo-relative root). Forcing either shape in here would trade two clean
 * handlers for one router full of `if (kind === ...)` branches — not a real
 * collapse.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { listSkills, getSkill } from '../skills.js';
import { listAgents, getAgent } from '../agents.js';
import { toDomainServiceError } from '../services/errors.js';

interface NamedDocService<TSummary, TDetail> {
  list(): Promise<TSummary[]>;
  get(name: string): Promise<TDetail>;
}

function createNamedDocsRouter<TSummary, TDetail>(
  basePath: string,
  service: NamedDocService<TSummary, TDetail>,
): express.Router {
  const router = express.Router();

  router.get(basePath, async (_req: Request, res: Response) => {
    res.json(await service.list());
  });

  router.get(`${basePath}/:name`, async (req: Request, res: Response) => {
    try {
      res.json(await service.get(req.params.name as string));
    } catch (err) {
      throw toDomainServiceError(err);
    }
  });

  return router;
}

export const skillsRouter = createNamedDocsRouter('/api/skills', {
  list: listSkills,
  get: getSkill,
});

export const agentDefsRouter = createNamedDocsRouter('/api/agent-roles', {
  list: listAgents,
  get: getAgent,
});
