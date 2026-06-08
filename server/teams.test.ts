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

beforeEach(() => {
  db = createTestDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-teams-'));
  // Create a fake target repo dir
  fs.mkdirSync(path.join(tmpDir, '.octomux'), { recursive: true });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── parseTeamConfig ──────────────────────────────────────────────────────────

const { parseTeamConfig, validateTeamConfig, runTeam } = await import('./teams.js');

describe('parseTeamConfig', () => {
  it('parses a minimal valid team.yaml', () => {
    const yaml = `
name: my-team
base_branch: main
schedule: "0 7 * * *"
notify_command: "echo done"
journal_dir: desk/journal
incidents_dir: desk/incidents
roster:
  - role: lead
    skeleton: desk-lead
    model: opus
`;
    const config = parseTeamConfig(yaml);
    expect(config.name).toBe('my-team');
    expect(config.base_branch).toBe('main');
    expect(config.schedule).toBe('0 7 * * *');
    expect(config.notify_command).toBe('echo done');
    expect(config.roster).toHaveLength(1);
    expect(config.roster[0].role).toBe('lead');
    expect(config.roster[0].skeleton).toBe('desk-lead');
    expect(config.roster[0].model).toBe('opus');
  });

  it('parses roster with optional overlay', () => {
    const yaml = `
name: t
base_branch: main
schedule: "0 7 * * *"
notify_command: "echo"
journal_dir: j
incidents_dir: i
roster:
  - role: researcher
    skeleton: researcher
    model: sonnet
    overlay: .octomux/roles/researcher.md
`;
    const config = parseTeamConfig(yaml);
    expect(config.roster[0].overlay).toBe('.octomux/roles/researcher.md');
  });

  it('throws on invalid YAML', () => {
    expect(() => parseTeamConfig('{ bad: yaml: :')).toThrow();
  });
});

describe('validateTeamConfig', () => {
  it('requires name', () => {
    expect(() =>
      validateTeamConfig({
        base_branch: 'main',
        schedule: '0 7 * * *',
        notify_command: 'echo',
        journal_dir: 'j',
        incidents_dir: 'i',
        roster: [{ role: 'lead', skeleton: 'desk-lead', model: 'opus' }],
      }),
    ).toThrow(/name/);
  });

  it('requires at least one roster entry', () => {
    expect(() =>
      validateTeamConfig({
        name: 'x',
        base_branch: 'main',
        schedule: '0 7 * * *',
        notify_command: 'echo',
        journal_dir: 'j',
        incidents_dir: 'i',
        roster: [],
      }),
    ).toThrow(/roster/);
  });

  it('requires a lead role in roster', () => {
    expect(() =>
      validateTeamConfig({
        name: 'x',
        base_branch: 'main',
        schedule: '0 7 * * *',
        notify_command: 'echo',
        journal_dir: 'j',
        incidents_dir: 'i',
        roster: [{ role: 'researcher', skeleton: 'researcher', model: 'sonnet' }],
      }),
    ).toThrow(/lead/);
  });

  it('passes for a valid config with lead', () => {
    expect(() =>
      validateTeamConfig({
        name: 'x',
        base_branch: 'main',
        schedule: '0 7 * * *',
        notify_command: 'echo',
        journal_dir: 'j',
        incidents_dir: 'i',
        roster: [{ role: 'lead', skeleton: 'desk-lead', model: 'opus' }],
      }),
    ).not.toThrow();
  });
});

describe('runTeam', () => {
  it('creates a Lead task with correct model and title', async () => {
    // Write a valid team.yaml into tmpDir
    const yaml = `
name: test-team
base_branch: main
schedule: "0 7 * * *"
notify_command: "echo done"
journal_dir: desk/journal
incidents_dir: desk/incidents
roster:
  - role: lead
    skeleton: desk-lead
    model: claude-opus-4-8
  - role: researcher
    skeleton: researcher
    model: claude-sonnet-4-6
`;
    fs.writeFileSync(path.join(tmpDir, '.octomux', 'team.yaml'), yaml);

    const taskId = await runTeam({ name: 'test-team', repoPath: tmpDir });

    // Verify a task was created in the DB
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task).toBeDefined();
    expect(task.model).toBe('claude-opus-4-8');
    expect(task.title).toContain('test-team');
  });

  it('sets the initial_prompt with skeleton content, team.yaml path, and roster', async () => {
    const yaml = `
name: test-team
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
    fs.writeFileSync(path.join(tmpDir, '.octomux', 'team.yaml'), yaml);

    const taskId = await runTeam({ name: 'test-team', repoPath: tmpDir });

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    expect(task.initial_prompt).toContain('team.yaml');
    expect(task.initial_prompt).toContain('test-team');
    expect(task.initial_prompt).toContain('desk-lead');
  });

  it('throws when team.yaml not found', async () => {
    await expect(runTeam({ name: 'missing', repoPath: tmpDir })).rejects.toThrow(/team\.yaml/);
  });
});
