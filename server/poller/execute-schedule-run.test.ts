import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { createTestDb } from '../test-helpers.js';
import { createSchedule } from '../repositories/schedules.js';
import { insertRun, listRunsForSchedule } from '../repositories/runs.js';

const mockRun = vi.fn().mockResolvedValue(undefined);

vi.mock('../workflows/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflows/registry.js')>();
  return {
    ...actual,
    getWorkflow: (kind: string) =>
      kind === 'weekly-update'
        ? { kind, run: (...args: unknown[]) => mockRun(...args) }
        : actual.getWorkflow(kind),
  };
});

import { executeScheduleRun } from './execute-schedule-run.js';

/** Collect pino JSON log lines into memory for assertions. */
function bufferStream() {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    lines(): Array<Record<string, unknown>> {
      return chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

describe('executeScheduleRun', () => {
  beforeEach(() => {
    createTestDb();
    mockRun.mockClear();
  });

  it('calls wf.run with the same context shape as the cron poller', async () => {
    const row = createSchedule({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
    });

    await executeScheduleRun(row.id, { trigger: 'manual' });

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo',
        scheduleId: row.id,
        trigger: 'manual',
      }),
    );
  });

  it('creates a runs row when the workflow handler inserts one', async () => {
    const row = createSchedule({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
    });

    mockRun.mockImplementationOnce(async (ctx: { scheduleId?: string }) => {
      insertRun({
        workflowKind: 'weekly-update',
        trigger: 'manual',
        scheduleId: ctx.scheduleId,
      });
    });

    await executeScheduleRun(row.id, { trigger: 'manual' });

    const runs = listRunsForSchedule(row.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].workflow_kind).toBe('weekly-update');
    expect(runs[0].trigger).toBe('manual');
  });

  // ── model/timeoutMs threading ───────────────────────────────────────────────

  it('threads row.model and row.timeout_ms into RunContext', async () => {
    const row = createSchedule({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
      model: 'claude-opus-4-8',
      timeoutMs: 600000,
    });

    await executeScheduleRun(row.id, { trigger: 'cron' });

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-4-8',
        timeoutMs: 600000,
      }),
    );
  });

  it('passes null model/timeoutMs when not set on the row', async () => {
    const row = createSchedule({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
    });

    await executeScheduleRun(row.id, { trigger: 'cron' });

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: null,
        timeoutMs: null,
      }),
    );
  });

  // ── run-start info log ──────────────────────────────────────────────────────

  it('logs run-start info with schedule_id, kind, trigger, model, timeout_ms, prompt_source', async () => {
    const { getLogger, setLogger } = await import('../logger.js');
    const original = getLogger();
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));

    try {
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * *',
        model: 'claude-sonnet-4-6',
        timeoutMs: 120000,
      });

      await executeScheduleRun(row.id, { trigger: 'cron' });

      const startLog = buf.lines().find((l) => l.msg === 'schedule run started');
      expect(startLog).toBeDefined();
      expect(startLog!.schedule_id).toBe(row.id);
      expect(startLog!.kind).toBe('weekly-update');
      expect(startLog!.trigger).toBe('cron');
      expect(startLog!.model).toBe('claude-sonnet-4-6');
      expect(startLog!.timeout_ms).toBe(120000);
      expect(startLog!.prompt_source).toBe('kind_skill');
    } finally {
      setLogger(original);
    }
  });

  it('logs prompt_source as schedule_override when schedule has a prompt', async () => {
    const { getLogger, setLogger } = await import('../logger.js');
    const original = getLogger();
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));

    try {
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * *',
        prompt: 'custom prompt text',
      });

      await executeScheduleRun(row.id, { trigger: 'manual' });

      const startLog = buf.lines().find((l) => l.msg === 'schedule run started');
      expect(startLog).toBeDefined();
      expect(startLog!.prompt_source).toBe('schedule_override');
    } finally {
      setLogger(original);
    }
  });

  it('logs model as "default" and timeout_ms as 300000 when row has nulls', async () => {
    const { getLogger, setLogger } = await import('../logger.js');
    const original = getLogger();
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));

    try {
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * *',
      });

      await executeScheduleRun(row.id, { trigger: 'cron' });

      const startLog = buf.lines().find((l) => l.msg === 'schedule run started');
      expect(startLog).toBeDefined();
      expect(startLog!.model).toBe('default');
      expect(startLog!.timeout_ms).toBe(300000);
    } finally {
      setLogger(original);
    }
  });
});
