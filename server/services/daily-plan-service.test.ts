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

import { runDailyPlanFromSchedule } from './daily-plan-service.js';

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
