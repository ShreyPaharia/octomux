import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../../test-helpers.js';
import { getDb } from '../../db.js';

const mockResolveSchedulePrompt = vi.fn();
const mockCreateChat = vi.fn();

vi.mock('../../schedule-prompt.js', () => ({
  resolveSchedulePrompt: (...args: unknown[]) => mockResolveSchedulePrompt(...args),
}));
vi.mock('../../chats.js', () => ({
  createChat: (...args: unknown[]) => mockCreateChat(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { runDailyPlanFromSchedule, finishDailyPlanRunForChat } from './run.js';
import { insertRun, getRun } from '../../repositories/runs.js';
import type { RunResult } from '../../types.js';

describe('runDailyPlanFromSchedule', () => {
  beforeEach(() => {
    createTestDb();
    mockResolveSchedulePrompt.mockReset();
    mockCreateChat.mockReset();
  });

  it('starts a chat with the resolved prompt and inserts a run row with chat_id set', async () => {
    mockResolveSchedulePrompt.mockResolvedValue('Prep the day.');
    mockCreateChat.mockResolvedValue({ id: 'chat-1' });

    await runDailyPlanFromSchedule({ scheduleId: 'sched-1', trigger: 'manual' });

    expect(mockResolveSchedulePrompt).toHaveBeenCalledWith({
      scheduleId: 'sched-1',
      kind: 'daily-plan',
    });
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
    mockResolveSchedulePrompt.mockResolvedValue('Prep the day.');
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
    mockResolveSchedulePrompt.mockResolvedValue('Prep the day.');
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
