import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { listEnabledSchedules, upsertSchedule, touchScheduleLastRun } from './schedules.js';

describe('schedules repo', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('upsertSchedule inserts a new row', () => {
    const row = upsertSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo',
      cron: '0 7 * * *',
    });

    expect(row.kind).toBe('prod-log-triage');
    expect(row.repo_path).toBe('/repo');
    expect(row.cron).toBe('0 7 * * *');
    expect(row.enabled).toBe(1);
    expect(row.last_run_at).toBeNull();
  });

  it('upsertSchedule updates on conflict (kind, repo_path)', () => {
    const first = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const second = upsertSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo',
      cron: '0 8 * * *',
      enabled: false,
    });

    expect(second.id).toBe(first.id);
    expect(second.cron).toBe('0 8 * * *');
    expect(second.enabled).toBe(0);
  });

  it('listEnabledSchedules returns only enabled rows', () => {
    upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo-a', cron: '0 7 * * *' });
    upsertSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo-b',
      cron: '0 7 * * *',
      enabled: false,
    });

    const rows = listEnabledSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0].repo_path).toBe('/repo-a');
  });

  it('upsertSchedule stores config_json, round-trips through listEnabledSchedules', () => {
    upsertSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo',
      cron: '0 7 * * *',
      config: { logCommand: 'flyctl logs -a my-app', maxIterations: 3 },
    });

    const [row] = listEnabledSchedules();
    expect(row.config_json).not.toBeNull();
    expect(JSON.parse(row.config_json as string)).toEqual({
      logCommand: 'flyctl logs -a my-app',
      maxIterations: 3,
    });
  });

  it('upsertSchedule without config leaves config_json null', () => {
    const row = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    expect(row.config_json).toBeNull();
  });

  it('touchScheduleLastRun sets last_run_at', () => {
    const row = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    expect(row.last_run_at).toBeNull();

    touchScheduleLastRun(row.id);

    const rows = listEnabledSchedules();
    expect(rows[0].last_run_at).not.toBeNull();
  });
});
