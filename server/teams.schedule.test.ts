import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestDb } from './test-helpers.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./task-runner.js', async () => ({
  startTask: vi.fn(async (task: any) => {
    const { getDb } = await import('./db.js');
    const db = getDb();
    db.prepare(
      `UPDATE tasks SET runtime_state = 'running', tmux_session = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(`octomux-agent-${task.id}`, task.id);
  }),
  closeTask: vi.fn(),
  deleteTask: vi.fn(),
}));

let db: Database.Database;
let tmpDir: string;

const VALID_YAML = `
name: sched-team
base_branch: main
schedule: "0 7 * * *"
notify_command: "echo done"
journal_dir: desk/journal
incidents_dir: desk/incidents
roster:
  - role: lead
    skeleton: desk-lead
    model: claude-opus-4-8
`;

beforeEach(() => {
  db = createTestDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-sched-'));
  fs.mkdirSync(path.join(tmpDir, '.octomux'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.octomux', 'team.yaml'), VALID_YAML);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const { cronMatches, upsertTeamSchedule, listTeamSchedules, pollTeamSchedules } =
  await import('./teams.js');

// ─── cronMatches ──────────────────────────────────────────────────────────────

describe('cronMatches', () => {
  const cases: Array<{ expr: string; date: string; expected: boolean }> = [
    { expr: '0 7 * * *', date: '2026-06-09T07:00:00Z', expected: true },
    { expr: '0 7 * * *', date: '2026-06-09T07:01:00Z', expected: false },
    { expr: '0 7 * * *', date: '2026-06-09T08:00:00Z', expected: false },
    { expr: '30 6 * * 1', date: '2026-06-08T06:30:00Z', expected: true }, // Monday
    { expr: '30 6 * * 1', date: '2026-06-09T06:30:00Z', expected: false }, // Tuesday
    { expr: '* * * * *', date: '2026-01-01T00:00:00Z', expected: true },
    { expr: '0 0 1 1 *', date: '2026-01-01T00:00:00Z', expected: true },
    { expr: '0 0 1 1 *', date: '2026-01-02T00:00:00Z', expected: false },
    { expr: 'bad', date: '2026-06-09T07:00:00Z', expected: false },
  ];

  it.each(cases)('expr="$expr" @ $date → $expected', ({ expr, date, expected }) => {
    expect(cronMatches(expr, new Date(date))).toBe(expected);
  });
});

// ─── upsertTeamSchedule / listTeamSchedules ───────────────────────────────────

describe('upsertTeamSchedule', () => {
  it('inserts a schedule row', () => {
    upsertTeamSchedule({ name: 'sched-team', repoPath: tmpDir, cron: '0 7 * * *' });
    const rows = listTeamSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('sched-team');
    expect(rows[0].cron).toBe('0 7 * * *');
    expect(rows[0].enabled).toBe(1);
  });

  it('updates an existing schedule (upsert)', () => {
    upsertTeamSchedule({ name: 'sched-team', repoPath: tmpDir, cron: '0 7 * * *' });
    upsertTeamSchedule({ name: 'sched-team', repoPath: tmpDir, cron: '0 8 * * *' });
    const rows = listTeamSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0].cron).toBe('0 8 * * *');
  });
});

// ─── pollTeamSchedules ────────────────────────────────────────────────────────

describe('pollTeamSchedules', () => {
  it('triggers a team run when schedule is due', async () => {
    upsertTeamSchedule({ name: 'sched-team', repoPath: tmpDir, cron: '0 7 * * *' });

    const dueTime = new Date('2026-06-09T07:00:00Z');
    await pollTeamSchedules(dueTime);

    const runs = db.prepare(`SELECT * FROM team_runs`).all() as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].team).toBe('sched-team');
    expect(runs[0].status).toBe('running');
  });

  it('does not trigger when cron does not match', async () => {
    upsertTeamSchedule({ name: 'sched-team', repoPath: tmpDir, cron: '0 7 * * *' });

    const notDue = new Date('2026-06-09T08:00:00Z');
    await pollTeamSchedules(notDue);

    const runs = db.prepare(`SELECT * FROM team_runs`).all() as any[];
    expect(runs).toHaveLength(0);
  });

  it('is idempotent — skips if a run is already active', async () => {
    upsertTeamSchedule({ name: 'sched-team', repoPath: tmpDir, cron: '0 7 * * *' });

    const dueTime = new Date('2026-06-09T07:00:00Z');
    await pollTeamSchedules(dueTime);
    await pollTeamSchedules(dueTime);

    const runs = db.prepare(`SELECT * FROM team_runs`).all() as any[];
    expect(runs).toHaveLength(1);
  });

  it('advances last_run_at after a successful run', async () => {
    upsertTeamSchedule({ name: 'sched-team', repoPath: tmpDir, cron: '0 7 * * *' });

    const before = db
      .prepare(`SELECT last_run_at FROM team_schedules WHERE name = 'sched-team'`)
      .get() as any;
    expect(before.last_run_at).toBeNull();

    await pollTeamSchedules(new Date('2026-06-09T07:00:00Z'));

    const after = db
      .prepare(`SELECT last_run_at FROM team_schedules WHERE name = 'sched-team'`)
      .get() as any;
    expect(after.last_run_at).not.toBeNull();
  });
});
