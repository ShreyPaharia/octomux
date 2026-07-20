import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSkill = vi.fn();
const mockRunSessionVertical = vi.fn();

vi.mock('../skills.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));
vi.mock('./session-vertical-service.js', () => ({
  runSessionVertical: (...args: unknown[]) => mockRunSessionVertical(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { runWeeklyUpdate } from './weekly-update-service.js';
import { WEEKLY_UPDATE_SCHEMA } from '../workflows/weekly-update/schema.js';

describe('runWeeklyUpdate', () => {
  beforeEach(() => {
    mockGetSkill.mockReset();
    mockRunSessionVertical.mockReset();
  });

  it('loads the skill and calls runSessionVertical with its content as input', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'weekly-update',
      content: 'Summarize the week.',
    });
    mockRunSessionVertical.mockResolvedValue({ result: { period: 'Mon 1 - 5' } });

    const { result } = await runWeeklyUpdate({
      repoPath: '/repos/my-app',
      scheduleId: 'sched-1',
    });

    expect(result).toEqual({ period: 'Mon 1 - 5' });
    expect(mockGetSkill).toHaveBeenCalledWith('weekly-update', { repoPath: '/repos/my-app' });
    expect(mockRunSessionVertical).toHaveBeenCalledTimes(1);
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.kind).toBe('weekly-update');
    expect(call.scheduleId).toBe('sched-1');
    expect(call.workspaceDir).toBe('/repos/my-app');
    expect(call.input).toBe('Summarize the week.');
    expect(call.outputSchema).toBe(WEEKLY_UPDATE_SCHEMA);
  });
});
