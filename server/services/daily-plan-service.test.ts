import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { getDb } from '../db.js';

const mockGetSkill = vi.fn();
const mockCreateChat = vi.fn();

vi.mock('../skills.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));
vi.mock('../chats.js', () => ({
  createChat: (...args: unknown[]) => mockCreateChat(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { runDailyPlanFromSchedule, finishDailyPlanRunForChat } from './daily-plan-service.js';
import { insertRun, getRun } from '../repositories/runs.js';
import type { RunResult } from '../types.js';

describe('runDailyPlanFromSchedule', () => {
  beforeEach(() => {
    createTestDb();
    mockGetSkill.mockReset();
    mockCreateChat.mockReset();
  });

  it('starts a chat with the skill prompt and inserts a run row with chat_id set', async () => {
    mockGetSkill.mockResolvedValue({ name: 'daily-plan', content: 'Prep the day.' });
    mockCreateChat.mockResolvedValue({ id: 'chat-1' });

    await runDailyPlanFromSchedule({ scheduleId: 'sched-1' });

    expect(mockGetSkill).toHaveBeenCalledWith('daily-plan');
    expect(mockCreateChat).toHaveBeenCalledWith({ prompt: 'Prep the day.' });

    const rows = getDb()
      .prepare(`SELECT * FROM runs WHERE workflow_kind = 'daily-plan'`)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].chat_id).toBe('chat-1');
    expect(rows[0].schedule_id).toBe('sched-1');
    expect(rows[0].trigger).toBe('cron');
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
