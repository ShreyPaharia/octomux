import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { upsertSchedule } from './repositories/schedules.js';

const mockGetSkill = vi.fn();

vi.mock('./skills.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));

import {
  resolveSchedulePrompt,
  getDefaultPromptForKind,
  skillContentOverridesForSchedule,
} from './schedule-prompt.js';

describe('schedule-prompt', () => {
  beforeEach(() => {
    createTestDb();
    mockGetSkill.mockReset();
    mockGetSkill.mockResolvedValue({ name: 'weekly-update', content: 'Default SKILL body' });
  });

  it('getDefaultPromptForKind loads the shipped skill', async () => {
    const content = await getDefaultPromptForKind('weekly-update', '/repo');
    expect(content).toBe('Default SKILL body');
    expect(mockGetSkill).toHaveBeenCalledWith('weekly-update', { repoPath: '/repo' });
  });

  it('resolveSchedulePrompt uses DB prompt when set', async () => {
    const row = upsertSchedule({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
      prompt: 'Custom DB prompt',
    });

    const content = await resolveSchedulePrompt({
      scheduleId: row.id,
      kind: 'weekly-update',
      repoPath: '/repo',
    });

    expect(content).toBe('Custom DB prompt');
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  it('resolveSchedulePrompt falls back to SKILL.md when DB prompt is null', async () => {
    const row = upsertSchedule({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
    });

    const content = await resolveSchedulePrompt({
      scheduleId: row.id,
      kind: 'weekly-update',
    });

    expect(content).toBe('Default SKILL body');
    expect(mockGetSkill).toHaveBeenCalledWith('weekly-update', { repoPath: '/repo' });
  });

  it('skillContentOverridesForSchedule returns override only for task-backed kinds', () => {
    expect(skillContentOverridesForSchedule({ kind: 'doc-drift', prompt: 'Override' })).toEqual({
      'doc-drift': 'Override',
    });
    expect(
      skillContentOverridesForSchedule({ kind: 'weekly-update', prompt: 'Override' }),
    ).toBeUndefined();
  });
});
