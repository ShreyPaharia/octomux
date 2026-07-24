import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../../test-helpers.js';
import { createSchedule } from '../../repositories/schedules.js';
import { listRunsForSchedule } from '../../repositories/runs.js';

// ─── Mock runSessionVertical ─────────────────────────────────────────────────

const mockRunSessionVertical = vi
  .fn()
  .mockResolvedValue({ result: { outcome: 'done', summary: 'ok' } });

vi.mock('../../services/session-vertical-service.js', () => ({
  runSessionVertical: (...args: unknown[]) => mockRunSessionVertical(...args),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

import { runCustom } from './run.js';

describe('runCustom', () => {
  beforeEach(() => {
    createTestDb();
    mockRunSessionVertical.mockClear();
    mockRunSessionVertical.mockResolvedValue({ result: { outcome: 'done', summary: 'ok' } });
  });

  it('inserts a failed run row and returns when the schedule has no prompt', async () => {
    const schedule = createSchedule({
      kind: 'custom',
      repoPath: '/repo',
      cron: '0 9 * * *',
      // no prompt
    });

    await runCustom({
      repoPath: '/repo',
      scheduleId: schedule.id,
      trigger: 'manual',
    });

    expect(mockRunSessionVertical).not.toHaveBeenCalled();

    const runs = listRunsForSchedule(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].workflow_kind).toBe('custom');
    expect(runs[0].status).toBe('failed');
    expect(runs[0].ended_at).not.toBeNull();

    const result = JSON.parse(runs[0].result_json!);
    expect(result.outcome).toBe('failed');
    expect(result.summary).toBe('Custom schedule has no prompt.');
  });

  it('inserts a failed run row and returns when the schedule prompt is empty string', async () => {
    const schedule = createSchedule({
      kind: 'custom',
      repoPath: '/repo',
      cron: '0 9 * * *',
      prompt: '',
    });

    await runCustom({
      repoPath: '/repo',
      scheduleId: schedule.id,
      trigger: 'cron',
    });

    expect(mockRunSessionVertical).not.toHaveBeenCalled();

    const runs = listRunsForSchedule(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
  });

  it('inserts a failed run row when the schedule does not exist', async () => {
    await runCustom({
      repoPath: '/repo',
      scheduleId: 'nonexistent-id',
      trigger: 'cron',
    });

    expect(mockRunSessionVertical).not.toHaveBeenCalled();
  });

  it('happy path: calls runSessionVertical with prompt, model, timeoutMs, and trigger', async () => {
    const schedule = createSchedule({
      kind: 'custom',
      repoPath: '/repo',
      cron: '0 9 * * *',
      prompt: 'Generate a weekly summary for {{repo}}.',
    });

    await runCustom({
      repoPath: '/repo',
      scheduleId: schedule.id,
      model: 'claude-opus-4-8',
      timeoutMs: 120000,
      trigger: 'manual',
    });

    expect(mockRunSessionVertical).toHaveBeenCalledTimes(1);
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.kind).toBe('custom');
    expect(call.scheduleId).toBe(schedule.id);
    expect(call.workspaceDir).toBe('/repo');
    // Prompt passed through (unknown placeholders left intact by interpolatePrompt)
    expect(call.input).toBe('Generate a weekly summary for {{repo}}.');
    expect(call.model).toBe('claude-opus-4-8');
    expect(call.timeoutMs).toBe(120000);
    expect(call.trigger).toBe('manual');
  });

  it('happy path: outputSchema has additionalProperties: false and required outcome+summary', async () => {
    const schedule = createSchedule({
      kind: 'custom',
      repoPath: '/repo',
      cron: '0 9 * * *',
      prompt: 'Run my custom check.',
    });

    await runCustom({
      repoPath: '/repo',
      scheduleId: schedule.id,
      trigger: 'cron',
    });

    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.outputSchema).toMatchObject({
      type: 'object',
      required: ['outcome', 'summary'],
      additionalProperties: false,
    });
    expect(call.outputSchema.properties).toHaveProperty('outcome');
    expect(call.outputSchema.properties).toHaveProperty('summary');
  });

  it('happy path: defaults trigger to cron when not provided', async () => {
    const schedule = createSchedule({
      kind: 'custom',
      repoPath: '/repo',
      cron: '0 9 * * *',
      prompt: 'Hello.',
    });

    await runCustom({ repoPath: '/repo', scheduleId: schedule.id });

    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.trigger).toBe('cron');
  });

  it('does not double-insert a run row on the happy path (runSessionVertical owns it)', async () => {
    // runSessionVertical is mocked and handles its own run row internally.
    // We verify runCustom does NOT call insertRun before handing off to runSessionVertical.
    // The only way to detect a double-insert is to check that listRunsForSchedule returns
    // exactly 0 rows (since the mock doesn't actually insert). If runCustom inserted its
    // own row, we'd see 1.
    const schedule = createSchedule({
      kind: 'custom',
      repoPath: '/repo',
      cron: '0 9 * * *',
      prompt: 'Do something.',
    });

    await runCustom({ repoPath: '/repo', scheduleId: schedule.id, trigger: 'cron' });

    // Mock doesn't actually insert a runs row — if runCustom did, we'd see 1.
    const runs = listRunsForSchedule(schedule.id);
    expect(runs).toHaveLength(0);
  });
});
