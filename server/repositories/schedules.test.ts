import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import {
  listEnabledSchedules,
  createSchedule,
  touchScheduleLastRun,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
} from './schedules.js';

describe('schedules repo', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('createSchedule inserts a new row', () => {
    const row = createSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo',
      cron: '0 7 * * *',
    });

    expect(row.kind).toBe('prod-log-triage');
    expect(row.repo_path).toBe('/repo');
    expect(row.cron).toBe('0 7 * * *');
    expect(row.enabled).toBe(1);
    expect(row.last_run_at).toBeNull();
    expect(row.name).toBeNull();
    expect(row.timezone).toBeNull();
    expect(row.model).toBeNull();
    expect(row.timeout_ms).toBeNull();
    expect(row.prompt).toBeNull();
  });

  it('createSchedule stores all optional fields', () => {
    const row = createSchedule({
      kind: 'slack-watcher',
      repoPath: '/repo',
      cron: '0 8 * * *',
      name: 'My Watcher',
      timezone: 'America/New_York',
      model: 'claude-opus-4-8',
      timeoutMs: 600000,
      prompt: 'custom prompt',
      config: { slackUserId: 'U123' },
    });

    expect(row.name).toBe('My Watcher');
    expect(row.timezone).toBe('America/New_York');
    expect(row.model).toBe('claude-opus-4-8');
    expect(row.timeout_ms).toBe(600000);
    expect(row.prompt).toBe('custom prompt');
    expect(row.config_json).not.toBeNull();
    expect(JSON.parse(row.config_json as string)).toEqual({ slackUserId: 'U123' });
  });

  it('two createSchedule calls for the same (kind, repo_path) both succeed (no UNIQUE constraint)', () => {
    const first = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const second = createSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo',
      cron: '0 8 * * *',
    });

    expect(first.id).not.toBe(second.id);
    expect(listSchedules()).toHaveLength(2);
  });

  it('listEnabledSchedules returns only enabled rows', () => {
    createSchedule({ kind: 'prod-log-triage', repoPath: '/repo-a', cron: '0 7 * * *' });
    createSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo-b',
      cron: '0 7 * * *',
      enabled: false,
    });

    const rows = listEnabledSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0].repo_path).toBe('/repo-a');
  });

  it('createSchedule stores config_json, round-trips through listEnabledSchedules', () => {
    createSchedule({
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

  it('createSchedule without config leaves config_json null', () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    expect(row.config_json).toBeNull();
  });

  it('touchScheduleLastRun sets last_run_at', () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    expect(row.last_run_at).toBeNull();

    touchScheduleLastRun(row.id);

    const rows = listEnabledSchedules();
    expect(rows[0].last_run_at).not.toBeNull();
  });

  it('listSchedules returns all rows, enabled and disabled', () => {
    createSchedule({ kind: 'prod-log-triage', repoPath: '/repo-a', cron: '0 7 * * *' });
    createSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo-b',
      cron: '0 7 * * *',
      enabled: false,
    });

    const rows = listSchedules();
    expect(rows).toHaveLength(2);
  });

  it('getSchedule returns a row by id', () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    expect(getSchedule(row.id)).toEqual(row);
  });

  it('getSchedule returns undefined for an unknown id', () => {
    expect(getSchedule('nope')).toBeUndefined();
  });

  it('updateSchedule partially updates cron/enabled/config', () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });

    const updated = updateSchedule(row.id, { cron: '0 8 * * *', enabled: false });

    expect(updated?.cron).toBe('0 8 * * *');
    expect(updated?.enabled).toBe(0);
    expect(updated?.repo_path).toBe('/repo');
  });

  it('updateSchedule serializes config to config_json', () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });

    const updated = updateSchedule(row.id, { config: { maxIterations: 7 } });

    expect(JSON.parse(updated?.config_json as string)).toEqual({ maxIterations: 7 });
  });

  it('updateSchedule patches new fields: repoPath/name/timezone/model/timeoutMs/prompt', () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });

    const updated = updateSchedule(row.id, {
      repoPath: '/new-repo',
      name: 'My Schedule',
      timezone: 'Europe/London',
      model: 'claude-sonnet-4-6',
      timeoutMs: 120000,
      prompt: 'override prompt',
    });

    expect(updated?.repo_path).toBe('/new-repo');
    expect(updated?.name).toBe('My Schedule');
    expect(updated?.timezone).toBe('Europe/London');
    expect(updated?.model).toBe('claude-sonnet-4-6');
    expect(updated?.timeout_ms).toBe(120000);
    expect(updated?.prompt).toBe('override prompt');
  });

  it('updateSchedule clears nullable fields when set to null', () => {
    const row = createSchedule({
      kind: 'slack-watcher',
      repoPath: '/repo',
      cron: '0 7 * * *',
      name: 'Named',
      timezone: 'US/Pacific',
      model: 'claude-opus-4-8',
      timeoutMs: 60000,
      prompt: 'some prompt',
    });

    const updated = updateSchedule(row.id, {
      name: null,
      timezone: null,
      model: null,
      timeoutMs: null,
      prompt: null,
    });

    expect(updated?.name).toBeNull();
    expect(updated?.timezone).toBeNull();
    expect(updated?.model).toBeNull();
    expect(updated?.timeout_ms).toBeNull();
    expect(updated?.prompt).toBeNull();
  });

  it('updateSchedule returns undefined for an unknown id', () => {
    expect(updateSchedule('nope', { cron: '0 8 * * *' })).toBeUndefined();
  });

  it('deleteSchedule removes the row', () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });

    deleteSchedule(row.id);

    expect(getSchedule(row.id)).toBeUndefined();
  });
});
