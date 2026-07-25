import express from 'express';
import type { Request, Response } from 'express';
import { childLogger } from '../logger.js';
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  type ScheduleRow,
  type CreateScheduleInput,
} from '../repositories/schedules.js';
import { listRunsForSchedule } from '../repositories/runs.js';
import { getWorkflow, listCronWorkflowKinds } from '../workflows/registry.js';
import { getPreset, listPresets } from '../workflows/presets.js';
import { validateWorkflowConfig, applyConfigDefaults } from '../workflows/config.js';
import { executeScheduleRun } from '../poller/execute-schedule-run.js';
import { validateCronWithTimezone } from '../schedules/cron.js';
import { badRequest, notFound, ServiceError } from '../services/errors.js';

const logger = childLogger('routes/schedules');

export const router = express.Router();

const MODEL_REGEX = /^[a-zA-Z0-9._:/-]{1,128}$/;
const TIMEOUT_MIN = 10_000;
const TIMEOUT_MAX = 86_400_000;

/** Envelope version for `GET /api/schedules/:id/export` / `POST /api/schedules/import`
 * (§5) — lets import reject foreign JSON with a clear message instead of a schema error. */
const SCHEDULE_EXPORT_VERSION = 1;

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

interface CreateScheduleBody {
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
}

/**
 * Shared create path for `POST /api/schedules` and `POST /api/schedules/import`
 * (§5: import "reuses the POST validation path verbatim").
 *
 * Config defaults are materialized at write time (ajv `useDefaults` against the
 * kind's `config` schema, §4.3) so `config_json` is always fully materialized —
 * `executeScheduleRun` never needs to re-resolve defaults at read time. The
 * prompt is copied from the kind's preset when the caller doesn't supply one
 * (§1: the row is a self-contained snapshot, not a live reference).
 */
function handleCreateSchedule(body: CreateScheduleBody): ScheduleRow {
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

  validateCronWithTimezone(body.cron, typeof timezone === 'string' ? timezone : null);
  validateModel(body.model);
  validateTimeoutMs(body.timeoutMs);
  validateScheduleConfig(body.kind, body.config);

  const enabledBool =
    typeof body.enabled === 'boolean' ? body.enabled : body.enabled === undefined ? true : true;

  const preset = getPreset(body.kind);
  // promptRequired mirrors GET /api/schedules/kinds: a kind whose preset ships
  // no prompt (today, only `custom`) needs an explicit one from the caller.
  const promptRequired = !preset?.prompt;
  const prompt = typeof body.prompt === 'string' ? body.prompt : preset?.prompt;

  if (promptRequired && enabledBool) {
    if (!prompt || !prompt.trim()) {
      throw badRequest(`${body.kind} schedules require a non-empty prompt`);
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw badRequest(`${body.kind} schedules require a non-empty name`);
    }
  }

  const wf = getWorkflow(body.kind)!;
  const config = applyConfigDefaults(wf, body.config) as CreateScheduleInput['config'];

  const row = createSchedule({
    kind: body.kind,
    repoPath: body.repoPath,
    cron: body.cron,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    config,
    name: typeof body.name === 'string' ? body.name : undefined,
    timezone: typeof timezone === 'string' ? timezone : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    prompt: typeof prompt === 'string' ? prompt : undefined,
  });

  logger.info({ schedule_id: row.id, kind: row.kind }, 'schedule: created via API');
  return row;
}

// NOTE: registered before '/api/schedules/:id' — Express matches routes in
// declaration order, so the literal 'kinds' segment must win over the :id param.
router.get('/api/schedules/kinds', (_req: Request, res: Response) => {
  res.json({
    kinds: listPresets().map((preset) => ({
      kind: preset.kind,
      displayName: preset.displayName,
      configSchema: preset.config ?? null,
      execution: preset.execution,
      defaultCron: preset.defaultCron ?? null,
      promptRequired: !preset.prompt,
      supportsTimeout: preset.execution === 'session',
    })),
  });
});

router.get('/api/schedules', (_req: Request, res: Response) => {
  res.json(listSchedules());
});

router.post('/api/schedules', (req: Request, res: Response) => {
  const row = handleCreateSchedule(req.body as CreateScheduleBody);
  res.status(201).json(row);
});

/**
 * Import a schedule from a `GET /api/schedules/:id/export` envelope. Body =
 * envelope + `repoPath` (not part of the envelope — export omits it, §5). All
 * other validation is identical to `POST /api/schedules`.
 */
router.post('/api/schedules/import', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (body.octomuxSchedule !== SCHEDULE_EXPORT_VERSION) {
    throw badRequest(
      'not a valid octomux schedule export (missing or mismatched "octomuxSchedule" envelope version)',
    );
  }

  const row = handleCreateSchedule({
    kind: body.kind,
    repoPath: body.repoPath,
    cron: body.cron,
    enabled: body.enabled,
    config: body.config,
    name: body.name,
    timezone: body.timezone,
    model: body.model,
    timeoutMs: body.timeoutMs,
    prompt: body.prompt,
  });

  logger.info({ schedule_id: row.id, kind: row.kind }, 'schedule: imported via API');
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

  // A kind whose preset ships no prompt (today, only `custom`) requires an
  // explicit prompt + name from the caller whenever the resulting row is enabled.
  const promptRequired = !getPreset(existing.kind)?.prompt;
  if (promptRequired) {
    const effectiveEnabled =
      typeof body.enabled === 'boolean' ? body.enabled : Boolean(existing.enabled);

    if (effectiveEnabled) {
      const effectivePrompt =
        'prompt' in body ? (body.prompt as string | null | undefined) : existing.prompt;
      const effectiveName =
        'name' in body ? (body.name as string | null | undefined) : existing.name;

      if (!effectivePrompt || !effectivePrompt.trim()) {
        throw badRequest(`${existing.kind} schedules require a non-empty prompt`);
      }
      if (!effectiveName || !effectiveName.trim()) {
        throw badRequest(`${existing.kind} schedules require a non-empty name`);
      }
    }
  }

  const patch: Parameters<typeof updateSchedule>[1] = {
    cron: typeof body.cron === 'string' ? body.cron : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    config:
      body.config !== undefined
        ? (applyConfigDefaults(getWorkflow(existing.kind)!, body.config) as Record<string, unknown>)
        : undefined,
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

/**
 * Export a schedule as a shareable JSON envelope (§5). Omits `id`, `repo_path`,
 * `last_run_at`, and timestamps — importing elsewhere creates a fresh row
 * against a caller-supplied `repoPath`.
 */
router.get('/api/schedules/:id/export', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const row = getSchedule(id);
  if (!row) throw notFound('Schedule not found');

  res.json({
    octomuxSchedule: SCHEDULE_EXPORT_VERSION,
    kind: row.kind,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    enabled: !!row.enabled,
    model: row.model,
    timeoutMs: row.timeout_ms,
    config: row.config_json ? JSON.parse(row.config_json) : undefined,
    prompt: row.prompt,
  });
});
