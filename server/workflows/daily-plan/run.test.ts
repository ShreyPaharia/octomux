import { describe, it, expect, vi, beforeEach } from '../../bun-test.js';

const mockCreateChat = vi.fn();

vi.mock('../../chats.js', () => ({
  createChat: (...args: unknown[]) => mockCreateChat(...args),
}));

const { createTestDb } = await import('../../test-helpers.js');
const { getDb } = await import('../../db.js');
const { runDailyPlanFromSchedule, finishDailyPlanRunForChat } = await import('./run.js');
const { insertRun, getRun } = await import('../../repositories/runs.js');

// ─── Import after mocks ─────────────────────────────────────────────────────

import type { RunResult } from '../../types.js';

/** Insert a schedule row with a prompt — schedule.prompt is the self-contained
 * source `runDailyPlanFromSchedule` now reads (spec/schedule-kinds-as-presets.md
 * §1), materialized from the preset at create time in production. */
function insertScheduleWithPrompt(id: string, prompt: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO schedules (id, kind, repo_path, cron, enabled, prompt) VALUES (?, 'daily-plan', '/repo', '0 9 * * *', 1, ?)`,
    )
    .run(id, prompt);
}

describe('runDailyPlanFromSchedule', () => {
  beforeEach(() => {
    createTestDb();
    mockCreateChat.mockReset();
  });

  it('starts a chat with the schedule prompt and inserts a run row with chat_id set', async () => {
    insertScheduleWithPrompt('sched-1', 'Prep the day.');
    mockCreateChat.mockResolvedValue({ id: 'chat-1' });

    await runDailyPlanFromSchedule({ scheduleId: 'sched-1', trigger: 'manual' });

    expect(mockCreateChat).toHaveBeenCalledWith({ prompt: 'Prep the day.', model: undefined });

    const rows = getDb()
      .prepare(`SELECT * FROM runs WHERE workflow_kind = 'daily-plan'`)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].chat_id).toBe('chat-1');
    expect(rows[0].schedule_id).toBe('sched-1');
    expect(rows[0].trigger).toBe('manual');
  });

  it('passes model to createChat when provided', async () => {
    insertScheduleWithPrompt('sched-2', 'Prep the day.');
    mockCreateChat.mockResolvedValue({ id: 'chat-2' });

    await runDailyPlanFromSchedule({
      scheduleId: 'sched-2',
      trigger: 'cron',
      model: 'claude-haiku-4-5-20251001',
    });

    expect(mockCreateChat).toHaveBeenCalledWith({
      prompt: 'Prep the day.',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('passes null model to createChat when model is null', async () => {
    insertScheduleWithPrompt('sched-3', 'Prep the day.');
    mockCreateChat.mockResolvedValue({ id: 'chat-3' });

    await runDailyPlanFromSchedule({
      scheduleId: 'sched-3',
      trigger: 'cron',
      model: null,
    });

    expect(mockCreateChat).toHaveBeenCalledWith({
      prompt: 'Prep the day.',
      model: null,
    });
  });

  it('throws when the schedule has no prompt', async () => {
    insertScheduleWithPrompt('sched-no-prompt', null);

    await expect(
      runDailyPlanFromSchedule({ scheduleId: 'sched-no-prompt', trigger: 'cron' }),
    ).rejects.toThrow(/no prompt/);
    expect(mockCreateChat).not.toHaveBeenCalled();
  });

  it('throws when the schedule does not exist', async () => {
    await expect(
      runDailyPlanFromSchedule({ scheduleId: 'does-not-exist', trigger: 'cron' }),
    ).rejects.toThrow(/no prompt/);
  });
});

describe('finishDailyPlanRunForChat', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('finishes the daily-plan run when its chat closes', () => {
    const run = insertRun({ workflowKind: 'daily-plan', trigger: 'cron', chatId: 'chat-1' });

    finishDailyPlanRunForChat('chat-1');

    const finished = getRun(run.id);
    expect(finished?.status).toBe('done');
    expect(finished?.ended_at).not.toBeNull();
    const result = JSON.parse(finished!.result_json!) as RunResult;
    expect(result.outcome).toBe('done');
    expect(result.links?.[0]).toEqual({ label: 'Chat', url: '/chats/chat-1' });
  });

  it('does nothing for an ordinary chat with no matching run', () => {
    expect(() => finishDailyPlanRunForChat('some-other-chat')).not.toThrow();
  });

  it('does not re-finish a run that is already terminal', () => {
    const run = insertRun({ workflowKind: 'daily-plan', trigger: 'cron', chatId: 'chat-1' });
    finishDailyPlanRunForChat('chat-1');
    const firstEndedAt = getRun(run.id)?.ended_at;

    finishDailyPlanRunForChat('chat-1'); // closing an already-closed chat again

    expect(getRun(run.id)?.ended_at).toBe(firstEndedAt);
  });
});
