import { Router, type Request, type Response } from 'express';
import { PR_EXTRACT_OUTPUT_SCHEMA } from '@octomux/types';
import { requireBearerHookToken } from '../../routes/hook-auth.js';
import { validateAgainstSchema } from '../../services/output-contract.js';
import {
  createExtract,
  getExtract,
  getExtractByTaskId,
  listExtracts,
} from '../../repositories/pr-extracts.js';
import { getTask } from '../../repositories/index.js';
import { listRunsForWorkflow, finishRun } from '../../repositories/runs.js';
import { badRequest, notFound, conflict } from '../../services/errors.js';
import { broadcast } from '../../events.js';
import { childLogger } from '../../logger.js';
import { registerPluginRoute, freezeCoreHttpRoutes } from '../../plugins/http-registry.js';
import type { PrExtractRisk, RunResult, Task } from '../../types.js';
import type { PluginRequest, PluginResponse, PluginRouteHandler } from '@octomux/plugin-api';

const logger = childLogger('workflows/pr-extract');

export const router = Router();

/**
 * `POST /api/pr-extracts/:taskId/emit` intentionally does NOT get a
 * `ctx.http.route()` twin. `PluginRequest.headers` exists today, so that is
 * no longer why. The real reason: this route's absolute path
 * (`/api/pr-extracts/:taskId/emit`) is hardcoded by callers —
 * `cli/src/commands/pr-extract-emit.ts` and any external hook sender — and
 * `/api/p/<pluginId>/...` (`server/api.ts`, off-limits here) is a fixed,
 * different mount point. There is no way to reproduce this exact legacy
 * absolute path under the new namespace, so it stays on the legacy Express
 * router, which still runs `requireBearerHookToken`.
 *
 * The two read-only GET routes below carry no auth and no header
 * dependency, so they migrate cleanly: both are also registered through
 * `registerPluginRoute()` (the same mechanism `ctx.http.route()` calls),
 * serving a second time at `/api/p/pr-extract/pr-extracts[...]`. The
 * literal legacy paths below keep answering unchanged — `src/lib/api/extractApi.ts`
 * and `cli/src/commands/pr-extract-emit.ts` hardcode them, and `/api/p` is a
 * fixed mount point in `server/api.ts` (off-limits here), so there is no way
 * to reproduce those exact absolute paths under the new namespace. Because
 * `apiRouter` therefore stays set, `pr-extract` still reports
 * `unloadable: false` — accurate, not a workaround artifact: the emit route
 * really can't unload cleanly under the current contract.
 */
const listExtractsHandler: PluginRouteHandler = (_req, res) => {
  res.status(200).json(listExtracts());
};

const getExtractHandler: PluginRouteHandler = (req, res) => {
  const row = getExtract(req.params.id);
  if (!row) throw notFound('Extract not found');
  res.status(200).json(row);
};

registerPluginRoute('pr-extract', 'GET', '/pr-extracts', listExtractsHandler);
registerPluginRoute('pr-extract', 'GET', '/pr-extracts/:id', getExtractHandler);
// Reserves 'pr-extract' against a plugin manifest claiming the same id — see
// `RESERVED_ROUTE_PLUGIN_IDS` in `http-registry.ts`. Must run after the two
// registrations above and before any plugin's `apply()` can reach
// `registerPluginRoute`, same ordering as `freezeCoreHarnesses()` /
// `freezeCoreProviders()`.
freezeCoreHttpRoutes();

/**
 * Finish the pr-extract run row for this task, if one exists. `pr_extracts`
 * stays the source of truth for the extract itself (see
 * spec/workflow-consolidation.md §5 shape C) — this only makes the run
 * visible as terminal instead of stuck at 'running' forever. Silently a
 * no-op when no run row was created for this task (e.g. an extract created
 * outside the cron/github-triggered flow).
 */
function finishPrExtractRun(
  task: Task,
  body: { area: string; risk: PrExtractRisk; loc: number },
): void {
  const run = listRunsForWorkflow('pr-extract').find(
    (r) => r.task_id === task.id && r.status === 'running',
  );
  if (!run) return;

  finishRun(run.id, {
    status: 'done',
    result: {
      outcome: 'done',
      summary: `Extracted: ${body.area} · risk ${body.risk} · ${body.loc} LOC`,
      links: task.pr_url ? [{ label: `PR #${task.pr_number}`, url: task.pr_url }] : undefined,
    } satisfies RunResult,
  });
  logger.info({ task_id: task.id, run_id: run.id }, 'pr-extract: run finished on emit');
}

router.post(
  '/api/pr-extracts/:taskId/emit',
  requireBearerHookToken,
  (req: Request, res: Response) => {
    const { taskId } = req.params as Record<string, string>;
    const task = getTask(taskId);
    if (!task) throw notFound('Task not found');
    if (!task.repo_path || task.pr_number == null || !task.pr_head_sha) {
      throw badRequest('Task has no associated PR to extract from');
    }

    const result = validateAgainstSchema('pr-extract', PR_EXTRACT_OUTPUT_SCHEMA, req.body);
    if (!result.valid) {
      throw badRequest(`Invalid pr-extract payload: ${(result.errors ?? []).join('; ')}`);
    }

    if (getExtractByTaskId(taskId)) {
      throw conflict('An extract already exists for this task');
    }

    const body = req.body as {
      area: string;
      risk: PrExtractRisk;
      has_migration: boolean;
      surface: string;
      loc: number;
    };

    const row = createExtract({
      taskId,
      repoPath: task.repo_path,
      prNumber: task.pr_number,
      prHeadSha: task.pr_head_sha,
      area: body.area,
      risk: body.risk,
      hasMigration: body.has_migration,
      surface: body.surface,
      loc: body.loc,
    });

    logger.info({ task_id: taskId, extract_id: row.id }, 'pr-extract emit recorded');
    finishPrExtractRun(task, body);
    broadcast({ type: 'pr_extract:created', payload: { taskId, extractId: row.id } });
    res.status(201).json(row);
  },
);

/**
 * Adapts a `PluginRouteHandler` (the new mechanism's shape) onto a plain
 * Express handler, so the legacy literal path and the new namespaced path
 * run the exact same handler function — one source of truth, not two
 * parallel implementations of "list extracts" / "get extract by id".
 */
function toExpressHandler(handler: PluginRouteHandler) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    const pluginReq: PluginRequest = {
      params: req.params as Record<string, string>,
      query: req.query as Record<string, unknown>,
      body: req.body,
      headers: req.headers as Record<string, string | string[] | undefined>,
    };
    const pluginRes: PluginResponse = {
      status(code: number) {
        res.status(code);
        return pluginRes;
      },
      json(body: unknown) {
        res.json(body);
      },
    };
    Promise.resolve()
      .then(() => handler(pluginReq, pluginRes))
      .catch(next);
  };
}

router.get('/api/pr-extracts', toExpressHandler(listExtractsHandler));

router.get('/api/pr-extracts/:id', toExpressHandler(getExtractHandler));
