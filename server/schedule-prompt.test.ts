import { describe, it, expect, beforeEach } from './bun-test.js';
import { createTestDb } from './test-helpers.js';
import { createSchedule } from './repositories/schedules.js';
import { getDb } from './db.js';
import { nanoid } from 'nanoid';
import { skillContentOverridesForScheduleId } from './schedule-prompt.js';

/** Insert a schedule row with a prompt field directly via SQL, bypassing
 * createSchedule's usual write path — used to cover null/empty prompt cases. */
function insertScheduleWithPrompt(opts: {
  kind: string;
  repoPath: string;
  cron: string;
  prompt: string | null;
}): { id: string } {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO schedules (id, kind, repo_path, cron, enabled, prompt)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(id, opts.kind, opts.repoPath, opts.cron, opts.prompt);
  return { id };
}

describe('skillContentOverridesForScheduleId', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('returns the schedule prompt keyed by kind when non-empty', () => {
    const { id } = insertScheduleWithPrompt({
      kind: 'doc-drift',
      repoPath: '/repo',
      cron: '0 7 * * *',
      prompt: 'My doc-drift prompt',
    });

    expect(skillContentOverridesForScheduleId(id)).toEqual({
      'doc-drift': 'My doc-drift prompt',
    });
  });

  it('returns undefined when the schedule has no prompt', () => {
    const row = createSchedule({ kind: 'weekly-update', repoPath: '/repo', cron: '0 7 * * *' });
    expect(skillContentOverridesForScheduleId(row.id)).toBeUndefined();
  });

  it.each([
    ['null prompt', null],
    ['empty-string prompt', ''],
  ] as const)('returns undefined for %s', (_label, promptValue) => {
    const { id } = insertScheduleWithPrompt({
      kind: 'doc-drift',
      repoPath: `/repo-${nanoid(4)}`,
      cron: '0 7 * * *',
      prompt: promptValue,
    });

    expect(skillContentOverridesForScheduleId(id)).toBeUndefined();
  });

  it('returns undefined when scheduleId is missing or unknown', () => {
    expect(skillContentOverridesForScheduleId(null)).toBeUndefined();
    expect(skillContentOverridesForScheduleId(undefined)).toBeUndefined();
    expect(skillContentOverridesForScheduleId('nope')).toBeUndefined();
  });
});
