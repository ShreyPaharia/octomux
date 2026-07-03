import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import {
  listTeamSchedules,
  listEnabledTeamSchedules,
  getTeamSchedule,
  upsertTeamSchedule,
  touchTeamScheduleLastRun,
  findActiveTeamRun,
  listTeamRuns,
  insertTeamRun,
  completeTeamRunByLeadTask,
} from './team-schedules.js';
import type Database from 'better-sqlite3';

describe('repositories/team-schedules', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // ─── upsertTeamSchedule / listTeamSchedules ───────────────────────────────

  describe('upsertTeamSchedule', () => {
    it('inserts a new schedule and reads it back', () => {
      upsertTeamSchedule({
        name: 'morning-crew',
        repoPath: '/tmp/repo',
        configPath: '/tmp/repo/.octomux/team.yaml',
        cron: '0 7 * * 1-5',
      });
      const row = getTeamSchedule('morning-crew');
      expect(row).toBeDefined();
      expect(row!.repo_path).toBe('/tmp/repo');
      expect(row!.cron).toBe('0 7 * * 1-5');
      expect(row!.enabled).toBe(1);
    });

    it('updates an existing schedule on conflict', () => {
      upsertTeamSchedule({
        name: 'crew',
        repoPath: '/old',
        configPath: '/old/.octomux/team.yaml',
        cron: '0 6 * * *',
      });
      upsertTeamSchedule({
        name: 'crew',
        repoPath: '/new',
        configPath: '/new/.octomux/team.yaml',
        cron: '0 8 * * *',
      });
      const row = getTeamSchedule('crew');
      expect(row!.repo_path).toBe('/new');
      expect(row!.cron).toBe('0 8 * * *');
    });
  });

  describe('listTeamSchedules', () => {
    it('returns all schedules ordered by name', () => {
      upsertTeamSchedule({
        name: 'zeta',
        repoPath: '/z',
        configPath: '/z/t.yaml',
        cron: '* * * * *',
      });
      upsertTeamSchedule({
        name: 'alpha',
        repoPath: '/a',
        configPath: '/a/t.yaml',
        cron: '* * * * *',
      });
      const rows = listTeamSchedules();
      const names = rows.map((r) => r.name);
      expect(names.indexOf('alpha')).toBeLessThan(names.indexOf('zeta'));
    });
  });

  describe('listEnabledTeamSchedules', () => {
    it('returns only enabled schedules', () => {
      upsertTeamSchedule({
        name: 'enabled-crew',
        repoPath: '/e',
        configPath: '/e/t.yaml',
        cron: '* * * * *',
      });
      db.prepare(
        `INSERT INTO team_schedules (name, repo_path, config_path, cron, enabled) VALUES ('disabled-crew', '/d', '/d/t.yaml', '* * * * *', 0)`,
      ).run();
      const rows = listEnabledTeamSchedules();
      expect(rows.some((r) => r.name === 'enabled-crew')).toBe(true);
      expect(rows.some((r) => r.name === 'disabled-crew')).toBe(false);
    });
  });

  // ─── touchTeamScheduleLastRun ─────────────────────────────────────────────

  describe('touchTeamScheduleLastRun', () => {
    it('sets last_run_at to now', () => {
      upsertTeamSchedule({
        name: 'touch-test',
        repoPath: '/t',
        configPath: '/t/t.yaml',
        cron: '* * * * *',
      });
      const before = getTeamSchedule('touch-test');
      expect(before!.last_run_at).toBeNull();
      touchTeamScheduleLastRun('touch-test');
      const after = getTeamSchedule('touch-test');
      expect(after!.last_run_at).not.toBeNull();
    });
  });

  // ─── insertTeamRun / listTeamRuns / completeTeamRunByLeadTask ─────────────

  describe('team_runs', () => {
    beforeEach(() => {
      insertTask(db, { id: 'lead-task', worktree: null });
    });

    it('insertTeamRun creates a running row', () => {
      const id = insertTeamRun({ team: 'my-team', lead_task_id: 'lead-task' });
      expect(id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
      const runs = listTeamRuns('my-team');
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('running');
      expect(runs[0]!.lead_task_id).toBe('lead-task');
    });

    it('completeTeamRunByLeadTask marks it done', () => {
      insertTeamRun({ team: 'fin-team', lead_task_id: 'lead-task' });
      completeTeamRunByLeadTask('lead-task');
      const runs = listTeamRuns('fin-team');
      expect(runs[0]!.status).toBe('done');
    });

    it('findActiveTeamRun returns undefined when task is not running', () => {
      insertTeamRun({ team: 'idle-team', lead_task_id: 'lead-task' });
      // lead-task is in 'idle' state (createTestDb default), so not 'running'/'setting_up'
      expect(findActiveTeamRun('idle-team')).toBeUndefined();
    });

    it('listTeamRuns returns [] for unknown team', () => {
      expect(listTeamRuns('no-such-team')).toHaveLength(0);
    });
  });
});
