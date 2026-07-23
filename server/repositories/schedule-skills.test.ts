import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import {
  getScheduleSkillRow,
  upsertScheduleSkill,
  deleteScheduleSkill,
} from './schedule-skills.js';

describe('schedule-skills repository', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('getScheduleSkillRow returns undefined when unseeded', () => {
    expect(getScheduleSkillRow('doc-drift')).toBeUndefined();
  });

  it('upsertScheduleSkill inserts then updates on conflict', () => {
    const inserted = upsertScheduleSkill('doc-drift', 'first body');
    expect(inserted.content).toBe('first body');
    expect(getScheduleSkillRow('doc-drift')?.content).toBe('first body');

    const updated = upsertScheduleSkill('doc-drift', 'second body');
    expect(updated.content).toBe('second body');
    expect(getScheduleSkillRow('doc-drift')?.content).toBe('second body');
  });

  it('deleteScheduleSkill removes the row and reports whether it existed', () => {
    upsertScheduleSkill('daily-plan', 'body');
    expect(deleteScheduleSkill('daily-plan')).toBe(true);
    expect(getScheduleSkillRow('daily-plan')).toBeUndefined();
    expect(deleteScheduleSkill('daily-plan')).toBe(false);
  });
});
