import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { createSchedule } from './repositories/schedules.js';
import { getDb } from './db.js';
import { getScheduleSkillRow, upsertScheduleSkill } from './repositories/schedule-skills.js';
import { nanoid } from 'nanoid';

const mockGetSkill = vi.fn();

vi.mock('./skills.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));

import {
  resolveSchedulePrompt,
  resolveSchedulePromptWithSource,
  resolveScheduleSkillContent,
  getDefaultPromptForKind,
  skillContentOverridesForScheduleId,
} from './schedule-prompt.js';

/** Insert a schedule row with a prompt field directly via SQL (A1 may not have landed). */
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

describe('schedule-prompt', () => {
  beforeEach(() => {
    createTestDb();
    mockGetSkill.mockReset();
    mockGetSkill.mockResolvedValue({ name: 'weekly-update', content: 'Shipped SKILL body' });
  });

  // ── Existing behaviour ──────────────────────────────────────────────────────

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

  it('editing the DB row changes the resolved prompt', async () => {
    await resolveScheduleSkillContent('weekly-update'); // seed
    upsertScheduleSkill('weekly-update', 'Newly edited body');

    expect(await resolveSchedulePrompt({ kind: 'weekly-update' })).toBe('Newly edited body');
  });

  // ── resolveSchedulePrompt / resolveSchedulePromptWithSource precedence ──────

  it('resolveSchedulePrompt returns kind skill when schedule has no prompt override', async () => {
    const row = createSchedule({ kind: 'weekly-update', repoPath: '/repo', cron: '0 7 * * *' });
    upsertScheduleSkill('weekly-update', 'Edited DB body');

    const content = await resolveSchedulePrompt({
      scheduleId: row.id,
      kind: 'weekly-update',
      repoPath: '/repo',
    });

    expect(content).toBe('Edited DB body');
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  it('resolveSchedulePromptWithSource returns kind_skill when no per-schedule override', async () => {
    const row = createSchedule({ kind: 'weekly-update', repoPath: '/repo', cron: '0 7 * * *' });
    upsertScheduleSkill('weekly-update', 'Kind skill body');

    const result = await resolveSchedulePromptWithSource({
      scheduleId: row.id,
      kind: 'weekly-update',
    });

    expect(result).toEqual({ content: 'Kind skill body', source: 'kind_skill' });
  });

  it('resolveSchedulePromptWithSource returns override when schedule.prompt is non-empty', async () => {
    const { id } = insertScheduleWithPrompt({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
      prompt: 'My custom override prompt',
    });
    upsertScheduleSkill('weekly-update', 'Should not be used');

    const result = await resolveSchedulePromptWithSource({
      scheduleId: id,
      kind: 'weekly-update',
    });

    expect(result).toEqual({ content: 'My custom override prompt', source: 'override' });
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  it('resolveSchedulePrompt honors non-empty schedule.prompt over kind skill', async () => {
    const { id } = insertScheduleWithPrompt({
      kind: 'weekly-update',
      repoPath: '/repo2',
      cron: '0 8 * * *',
      prompt: 'Override wins',
    });
    upsertScheduleSkill('weekly-update', 'Kind skill body');

    const content = await resolveSchedulePrompt({
      scheduleId: id,
      kind: 'weekly-update',
    });

    expect(content).toBe('Override wins');
  });

  it('resolveSchedulePromptWithSource returns kind_skill when schedule.prompt is null', async () => {
    const { id } = insertScheduleWithPrompt({
      kind: 'weekly-update',
      repoPath: '/repo3',
      cron: '0 9 * * *',
      prompt: null,
    });
    upsertScheduleSkill('weekly-update', 'Kind skill fallback');

    const result = await resolveSchedulePromptWithSource({
      scheduleId: id,
      kind: 'weekly-update',
    });

    expect(result).toEqual({ content: 'Kind skill fallback', source: 'kind_skill' });
  });

  it('resolveSchedulePromptWithSource falls through to kind skill when scheduleId is absent', async () => {
    upsertScheduleSkill('slack-watcher', 'Slack watcher skill');
    mockGetSkill.mockResolvedValue({ name: 'slack-watcher', content: 'Slack watcher skill' });

    const result = await resolveSchedulePromptWithSource({ kind: 'slack-watcher' });

    expect(result.source).toBe('kind_skill');
    expect(result.content).toBe('Slack watcher skill');
  });

  it('resolveSchedulePromptWithSource lazily seeds the kind skill from SKILL.md', async () => {
    mockGetSkill.mockResolvedValue({ name: 'daily-plan', content: 'Daily plan shipped body' });

    const result = await resolveSchedulePromptWithSource({ kind: 'daily-plan' });

    expect(result.source).toBe('kind_skill');
    expect(result.content).toBe('Daily plan shipped body');
    expect(getScheduleSkillRow('daily-plan')?.content).toBe('Daily plan shipped body');
  });

  // ── skillContentOverridesForScheduleId ─────────────────────────────────────

  it('skillContentOverridesForScheduleId injects DB body for task-backed kinds (no override)', async () => {
    const row = createSchedule({ kind: 'doc-drift', repoPath: '/repo', cron: '0 7 * * *' });
    mockGetSkill.mockResolvedValue({ name: 'doc-drift', content: 'Doc drift body' });

    expect(await skillContentOverridesForScheduleId(row.id)).toEqual({
      'doc-drift': 'Doc drift body',
    });
  });

  it('skillContentOverridesForScheduleId uses schedule.prompt override for doc-drift', async () => {
    const { id } = insertScheduleWithPrompt({
      kind: 'doc-drift',
      repoPath: '/override-repo',
      cron: '0 7 * * *',
      prompt: 'My doc-drift override',
    });

    const result = await skillContentOverridesForScheduleId(id);

    expect(result).toEqual({ 'doc-drift': 'My doc-drift override' });
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  it('skillContentOverridesForScheduleId uses schedule.prompt override for prod-log-triage', async () => {
    const { id } = insertScheduleWithPrompt({
      kind: 'prod-log-triage',
      repoPath: '/triage-repo',
      cron: '0 7 * * *',
      prompt: 'My triage override',
    });

    const result = await skillContentOverridesForScheduleId(id);

    expect(result).toEqual({ 'prod-log-triage': 'My triage override' });
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  it('skillContentOverridesForScheduleId returns undefined for non-task-backed kinds', async () => {
    const row = createSchedule({ kind: 'weekly-update', repoPath: '/repo', cron: '0 7 * * *' });
    expect(await skillContentOverridesForScheduleId(row.id)).toBeUndefined();
  });

  it('skillContentOverridesForScheduleId returns undefined when scheduleId is missing', async () => {
    expect(await skillContentOverridesForScheduleId(null)).toBeUndefined();
    expect(await skillContentOverridesForScheduleId('nope')).toBeUndefined();
  });

  it.each([
    ['null prompt', null, 'kind_skill'],
    ['empty-string prompt is treated as falsy', '', 'kind_skill'],
  ] as const)(
    'skillContentOverridesForScheduleId falls back to kind skill when prompt is %s',
    async (_label, promptValue, _expectedSource) => {
      mockGetSkill.mockResolvedValue({ name: 'doc-drift', content: 'Doc drift skill body' });
      const { id } = insertScheduleWithPrompt({
        kind: 'doc-drift',
        repoPath: `/repo-${nanoid(4)}`,
        cron: '0 7 * * *',
        prompt: promptValue,
      });

      const result = await skillContentOverridesForScheduleId(id);

      expect(result).toEqual({ 'doc-drift': 'Doc drift skill body' });
    },
  );
});
