import express from 'express';
import type { Request, Response } from 'express';
import { Cron } from 'croner';
import { childLogger } from '../logger.js';
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from '../repositories/schedules.js';
import { listRunsForSchedule } from '../repositories/runs.js';
import { getWorkflow, listCronWorkflowKinds } from '../workflows/registry.js';
import { validateWorkflowConfig } from '../workflows/config.js';
import { executeScheduleRun } from '../poller/execute-schedule-run.js';
import { resolveSchedulePromptWithSource } from '../schedule-prompt.js';
import { badRequest, notFound, ServiceError } from '../services/errors.js';

const logger = childLogger('routes/schedules');

export const router = express.Router();

const MODEL_REGEX = /^[a-zA-Z0-9._:/-]{1,128}$/;
const TIMEOUT_MIN = 10_000;
const TIMEOUT_MAX = 86_400_000;

function assertCronKind(kind: string): void {
  if (!listCronWorkflowKinds().includes(kind)) {
    throw badRequest(`kind must be one of: ${listCronWorkflowKinds().join(', ')}`);
  }
}

function validateScheduleConfig(kind: string, config: unknown): void {
  const wf = getWorkflow(kind);
  if (!wf) throw badRequest(`unknown workflow kind: ${kind}`);
  if (config === undefined) return;
  const result = validateWorkflowConfig(wf, config);
  if (!result.valid) {
    throw new ServiceError('config validation failed', 400, {
      error: 'config validation failed',
      details: result.errors,
    });
  }
}

/**
 * Validate a cron expression against a timezone.
 * Throws a 400 badRequest distinguishing expression vs. timezone errors.
 *
 * croner does not throw at construction time for invalid timezones — it only
 * throws on .match(). We probe with a .match() call to trigger validation.
 * To distinguish expression errors from timezone errors, we first try with UTC:
 * if UTC also throws, the expression is bad; otherwise the timezone is bad.
 */
function validateCronWithTimezone(expr: string, timezone?: string | null): void {
  const tz = timezone ?? 'UTC';
  try {
    const job = new Cron(expr, { timezone: tz, paused: true });
    // Probe to trigger timezone validation (croner validates timezone lazily on match)
    job.match(new Date());
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    // Distinguish: try with UTC — if it also throws, the expression is bad;
    // if UTC works, the timezone is the problem.
    if (tz !== 'UTC') {
      try {
        const utcJob = new Cron(expr, { timezone: 'UTC', paused: true });
        utcJob.match(new Date());
        // Expression valid with UTC → timezone is the problem
        throw badRequest(`invalid timezone: ${tz}`);
      } catch (innerErr) {
        if (innerErr instanceof ServiceError) throw innerErr;
        // Also fails with UTC → expression is the problem
        throw badRequest(`invalid cron expression: ${expr}`);
      }
    }
    throw badRequest(`invalid cron expression: ${expr}`);
  }
}

function validateModel(model: unknown): void {
  if (model === null || model === undefined) return;
  if (typeof model !== 'string' || !MODEL_REGEX.test(model)) {
    throw badRequest('model must match ^[a-zA-Z0-9._:/-]{1,128}$');
  }
}

function validateTimeoutMs(timeoutMs: unknown): void {
  if (timeoutMs === null || timeoutMs === undefined) return;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < TIMEOUT_MIN ||
    timeoutMs > TIMEOUT_MAX
  ) {
    throw badRequest(`timeoutMs must be an integer between ${TIMEOUT_MIN} and ${TIMEOUT_MAX}`);
  }
}

// NOTE: registered before '/api/schedules/:id' — Express matches routes in
// declaration order, so the literal 'kinds' segment must win over the :id param.
router.get('/api/schedules/kinds', (_req: Request, res: Response) => {
  res.json({
    kinds: listCronWorkflowKinds().map((kind) => {
      const wf = getWorkflow(kind)!;
      return {
        kind: wf.kind,
        displayName: wf.displayName,
        configSchema: wf.config ?? null,
        execution: wf.execution ?? null,
        promptRequired: wf.kind === 'custom',
        supportsTimeout: wf.execution === 'session',
      };
    }),
  });
});

// NOTE: registered before '/api/schedules/:id' to avoid :id capturing 'effective-prompt'
// is NOT needed here because Express matches the literal 'kinds' before :id only when
// the route is registered first. effective-prompt is on /:id/effective-prompt so the
// sub-path is distinct — but we register it early to be explicit.
router.get('/api/schedules/:id/effective-prompt', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const existing = getSchedule(id);
  if (!existing) throw notFound('Schedule not found');

  const result = await resolveSchedulePromptWithSource({ scheduleId: id, kind: existing.kind });
  res.json(result);
});

router.get('/api/schedules', (_req: Request, res: Response) => {
  res.json(listSchedules());
});

router.post('/api/schedules', (req: Request, res: Response) => {
  const body = req.body as {
    kind?: unknown;
    repoPath?: unknown;
    cron?: unknown;
    enabled?: unknown;
    config?: unknown;
    name?: unknown;
    timezone?: unknown;
    model?: unknown;
    timeoutMs?: unknown;
    prompt?: unknown;
  };

  if (typeof body.kind !== 'string') {
    throw badRequest('kind is required');
  }
  assertCronKind(body.kind);
  if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
    throw badRequest('repoPath is required');
  }
  if (typeof body.cron !== 'string' || !body.cron.trim()) {
    throw badRequest('cron is required');
  }

  const timezone = body.timezone !== undefined ? (body.timezone as string | null) : undefined;

  // Validate cron + timezone together
  validateCronWithTimezone(body.cron, typeof timezone === 'string' ? timezone : null);

  // Validate model
  validateModel(body.model);

  // Validate timeoutMs
  validateTimeoutMs(body.timeoutMs);

  validateScheduleConfig(body.kind, body.config);

  // Determine effective enabled state
  const enabledBool =
    typeof body.enabled === 'boolean' ? body.enabled : body.enabled === undefined ? true : true;

  // custom kind: when enabled, require non-empty prompt and non-empty name
  if (body.kind === 'custom' && enabledBool) {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
      throw badRequest('custom schedules require a non-empty prompt');
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw badRequest('custom schedules require a non-empty name');
    }
  }

  const row = createSchedule({
    kind: body.kind,
    repoPath: body.repoPath,
    cron: body.cron,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    config: body.config as Record<string, unknown> | undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    timezone: typeof timezone === 'string' ? timezone : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
  });

  logger.info({ schedule_id: row.id, kind: row.kind }, 'schedule: created via API');
  res.status(201).json(row);
});

router.patch('/api/schedules/:id', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const body = req.body as {
    cron?: unknown;
    enabled?: unknown;
    config?: unknown;
    name?: unknown;
    repoPath?: unknown;
    timezone?: unknown;
    model?: unknown;
    timeoutMs?: unknown;
    prompt?: unknown;
  };

  if (body.cron !== undefined && (typeof body.cron !== 'string' || !body.cron.trim())) {
    throw badRequest('cron must be a non-empty string');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw badRequest('enabled must be a boolean');
  }

  const existing = getSchedule(id);
  if (!existing) throw notFound('Schedule not found');

  // Validate cron + timezone pair (using effective values after patch)
  const effectiveCron = typeof body.cron === 'string' ? body.cron : existing.cron;
  const effectiveTimezone =
    'timezone' in body ? (body.timezone as string | null | undefined) : existing.timezone;
  validateCronWithTimezone(effectiveCron, effectiveTimezone ?? null);

  // Validate model
  validateModel(body.model);

  // Validate timeoutMs
  validateTimeoutMs(body.timeoutMs);

  if (body.config !== undefined) {
    validateScheduleConfig(existing.kind, body.config);
  }

  // custom kind: when the resulting row would be enabled, require non-empty prompt and name
  if (existing.kind === 'custom') {
    const effectiveEnabled =
      typeof body.enabled === 'boolean' ? body.enabled : Boolean(existing.enabled);

    if (effectiveEnabled) {
      const effectivePrompt =
        'prompt' in body ? (body.prompt as string | null | undefined) : existing.prompt;
      const effectiveName =
        'name' in body ? (body.name as string | null | undefined) : existing.name;

      if (!effectivePrompt || !effectivePrompt.trim()) {
        throw badRequest('custom schedules require a non-empty prompt');
      }
      if (!effectiveName || !effectiveName.trim()) {
        throw badRequest('custom schedules require a non-empty name');
      }
    }
  }

  const patch: Parameters<typeof updateSchedule>[1] = {
    cron: typeof body.cron === 'string' ? body.cron : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    config: body.config as Record<string, unknown> | undefined,
  };

  if ('name' in body) {
    patch.name = (body.name as string | null | undefined) ?? null;
  }
  if ('repoPath' in body) {
    patch.repoPath = body.repoPath as string;
  }
  if ('timezone' in body) {
    patch.timezone = (body.timezone as string | null | undefined) ?? null;
  }
  if ('model' in body) {
    patch.model = (body.model as string | null | undefined) ?? null;
  }
  if ('timeoutMs' in body) {
    patch.timeoutMs = (body.timeoutMs as number | null | undefined) ?? null;
  }
  if ('prompt' in body) {
    patch.prompt = (body.prompt as string | null | undefined) ?? null;
  }

  const updated = updateSchedule(id, patch);
  if (!updated) throw notFound('Schedule not found');

  res.json(updated);
});

router.post('/api/schedules/:id/run', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  if (!getSchedule(id)) throw notFound('Schedule not found');

  await executeScheduleRun(id, { trigger: 'manual' });
  res.status(202).json({ ok: true });
});

router.delete('/api/schedules/:id', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  if (!getSchedule(id)) throw notFound('Schedule not found');

  deleteSchedule(id);
  res.status(204).send();
});

router.get('/api/schedules/:id/runs', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  if (!getSchedule(id)) throw notFound('Schedule not found');

  res.json({ runs: listRunsForSchedule(id) });
});
