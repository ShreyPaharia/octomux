import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveSchedulePrompt = vi.fn();

vi.mock('../../schedule-prompt.js', () => ({
  resolveSchedulePrompt: (...args: unknown[]) => mockResolveSchedulePrompt(...args),
}));
vi.mock('../../services/session-vertical-service.js', () => ({
  runSessionVertical: vi.fn().mockResolvedValue({ result: { period: 'Mon 1 - 5' } }),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { runWeeklyUpdate } from './run.js';
import { WEEKLY_UPDATE_SCHEMA } from './schema.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';

describe('runWeeklyUpdate', () => {
  beforeEach(() => {
    mockResolveSchedulePrompt.mockReset();
    vi.mocked(runSessionVertical).mockClear();
  });

  it('loads the prompt via resolveSchedulePrompt and calls runSessionVertical', async () => {
    mockResolveSchedulePrompt.mockResolvedValue('Summarize the week.');

    const { result } = await runWeeklyUpdate({
      repoPath: '/repos/my-app',
      scheduleId: 'sched-1',
      trigger: 'manual',
    });

    expect(result).toEqual({ period: 'Mon 1 - 5' });
    expect(mockResolveSchedulePrompt).toHaveBeenCalledWith({
      scheduleId: 'sched-1',
      kind: 'weekly-update',
      repoPath: '/repos/my-app',
    });
    expect(runSessionVertical).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runSessionVertical).mock.calls[0][0];
    expect(call.kind).toBe('weekly-update');
    expect(call.scheduleId).toBe('sched-1');
    expect(call.workspaceDir).toBe('/repos/my-app');
    expect(call.input).toBe('Summarize the week.');
    expect(call.outputSchema).toBe(WEEKLY_UPDATE_SCHEMA);
    expect(call.trigger).toBe('manual');
  });
});
