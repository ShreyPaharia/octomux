import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { upsertSchedule } from './repositories/schedules.js';
import { getScheduleSkillRow, upsertScheduleSkill } from './repositories/schedule-skills.js';

const mockGetSkill = vi.fn();

vi.mock('./skills.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));

import {
  resolveSchedulePrompt,
  resolveScheduleSkillContent,
  getDefaultPromptForKind,
  skillContentOverridesForScheduleId,
} from './schedule-prompt.js';

describe('schedule-prompt', () => {
  beforeEach(() => {
    createTestDb();
    mockGetSkill.mockReset();
    mockGetSkill.mockResolvedValue({ name: 'weekly-update', content: 'Shipped SKILL body' });
  });

  it('getDefaultPromptForKind loads the shipped skill (no repo override)', async () => {
    const content = await getDefaultPromptForKind('weekly-update');
    expect(content).toBe('Shipped SKILL body');
    expect(mockGetSkill).toHaveBeenCalledWith('weekly-update');
  });

  it('resolveScheduleSkillContent lazily seeds from the shipped default and persists it', async () => {
    expect(getScheduleSkillRow('weekly-update')).toBeUndefined();

    const content = await resolveScheduleSkillContent('weekly-update');
    expect(content).toBe('Shipped SKILL body');
    expect(getScheduleSkillRow('weekly-update')?.content).toBe('Shipped SKILL body');
  });

  it('resolveScheduleSkillContent returns the DB body once seeded — no SKILL.md read', async () => {
    upsertScheduleSkill('weekly-update', 'Edited DB body');

    const content = await resolveScheduleSkillContent('weekly-update');
    expect(content).toBe('Edited DB body');
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  it('resolveSchedulePrompt returns the DB body and ignores the per-schedule prompt', async () => {
    const row = upsertSchedule({ kind: 'weekly-update', repoPath: '/repo', cron: '0 7 * * *' });
    upsertScheduleSkill('weekly-update', 'Edited DB body');

    const content = await resolveSchedulePrompt({
      scheduleId: row.id,
      kind: 'weekly-update',
      repoPath: '/repo',
    });

    expect(content).toBe('Edited DB body');
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  it('editing the DB row changes the resolved prompt', async () => {
    await resolveScheduleSkillContent('weekly-update'); // seed
    upsertScheduleSkill('weekly-update', 'Newly edited body');

    expect(await resolveSchedulePrompt({ kind: 'weekly-update' })).toBe('Newly edited body');
  });

  it('skillContentOverridesForScheduleId always injects the DB body for task-backed kinds', async () => {
    const row = upsertSchedule({ kind: 'doc-drift', repoPath: '/repo', cron: '0 7 * * *' });
    mockGetSkill.mockResolvedValue({ name: 'doc-drift', content: 'Doc drift body' });

    expect(await skillContentOverridesForScheduleId(row.id)).toEqual({
      'doc-drift': 'Doc drift body',
    });
  });

  it('skillContentOverridesForScheduleId returns undefined for non-task-backed kinds', async () => {
    const row = upsertSchedule({ kind: 'weekly-update', repoPath: '/repo', cron: '0 7 * * *' });
    expect(await skillContentOverridesForScheduleId(row.id)).toBeUndefined();
  });

  it('skillContentOverridesForScheduleId returns undefined when scheduleId is missing', async () => {
    expect(await skillContentOverridesForScheduleId(null)).toBeUndefined();
    expect(await skillContentOverridesForScheduleId('nope')).toBeUndefined();
  });
});
