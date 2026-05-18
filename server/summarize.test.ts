/**
 * C3: Tests for server/summarize.ts + integration with hooks Stop handler.
 *
 * Covers: builtin-disabled fallback, success path, error swallowed, CLI args.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestDb, insertTask, insertAgent, findCallback } from './test-helpers.js';
import { createApp } from './app.js';

// ─── child_process mock ──────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: vi.fn((..._args: unknown[]) => {
    const cb = findCallback(..._args);
    if (cb) cb(null, { stdout: '', stderr: '' });
    return undefined as never;
  }),
}));

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
  isHookEnabled: vi.fn(() => true),
  invalidateHookEnabledCache: vi.fn(),
}));

import { summarizeAgentProgress } from './summarize.js';
import { execFile } from 'child_process';
const mockedExecFile = vi.mocked(execFile);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function enableBuiltin(db: Database.Database, enabled: boolean) {
  db.prepare(
    `INSERT INTO hook_settings (scope, key, enabled, updated_at)
     VALUES ('builtin', 'summarize-progress', ?, datetime('now'))
     ON CONFLICT(scope, key) DO UPDATE SET enabled = excluded.enabled`,
  ).run(enabled ? 1 : 0);
}

function getTaskSummary(db: Database.Database, taskId: string): string | null {
  const row = db.prepare('SELECT current_summary FROM tasks WHERE id = ?').get(taskId) as
    | { current_summary: string | null }
    | undefined;
  return row?.current_summary ?? null;
}

function mockClaudeOk(stdout: string) {
  mockedExecFile.mockImplementationOnce(((...args: unknown[]) => {
    const cb = findCallback(...args);
    if (cb) cb(null, { stdout, stderr: '' });
    return undefined as never;
  }) as never);
}

function mockClaudeFail(err: Error) {
  mockedExecFile.mockImplementationOnce(((...args: unknown[]) => {
    const cb = findCallback(...args);
    if (cb) cb(err);
    return undefined as never;
  }) as never);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('C3: summarizeAgentProgress', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('does nothing when builtin hook is disabled (missing row = disabled)', async () => {
    // No hook_settings row → defaults to disabled for builtin
    await summarizeAgentProgress('task1', 'agent1');
    const claudeCalls = mockedExecFile.mock.calls.filter((c) => c[0] === 'claude');
    expect(claudeCalls).toHaveLength(0);
  });

  it('writes summary to DB on success', async () => {
    enableBuiltin(db, true);

    insertTask(db, { id: 'task1', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, { id: 'agent1', task_id: 'task1', status: 'running' });

    db.prepare(
      `INSERT INTO task_updates (id, task_id, agent_id, kind, body) VALUES ('u1', 'task1', 'agent1', 'summary', 'Read server/api.ts')`,
    ).run();

    mockClaudeOk('Implemented hook registry endpoints.');

    await summarizeAgentProgress('task1', 'agent1');

    const summary = getTaskSummary(db, 'task1');
    expect(summary).toBe('Implemented hook registry endpoints.');
    const claudeCalls = mockedExecFile.mock.calls.filter((c) => c[0] === 'claude');
    expect(claudeCalls).toHaveLength(1);
  });

  it('swallows CLI errors — never throws', async () => {
    enableBuiltin(db, true);

    insertTask(db, { id: 'task1', runtime_state: 'running', workflow_status: 'in_progress' });
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, body) VALUES ('u1', 'task1', 'summary', 'Did something')`,
    ).run();

    mockClaudeFail(new Error('claude not found'));

    await expect(summarizeAgentProgress('task1', 'agent1')).resolves.toBeUndefined();
    expect(getTaskSummary(db, 'task1')).toBeNull();
  });

  it('truncates summary to 120 chars', async () => {
    enableBuiltin(db, true);

    insertTask(db, { id: 'task1', runtime_state: 'running', workflow_status: 'in_progress' });
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, body) VALUES ('u1', 'task1', 'summary', 'content')`,
    ).run();

    mockClaudeOk('A'.repeat(200));

    await summarizeAgentProgress('task1', 'agent1');

    const summary = getTaskSummary(db, 'task1');
    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(120);
  });

  it('passes transcript and haiku flags to claude -p', async () => {
    enableBuiltin(db, true);

    insertTask(db, { id: 'task1', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, { id: 'agent1', task_id: 'task1', status: 'running' });

    db.prepare(
      `INSERT INTO task_updates (id, task_id, agent_id, kind, body) VALUES ('u1', 'task1', 'agent1', 'summary', 'Called Bash: ls -la')`,
    ).run();
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, from_status, to_status) VALUES ('u2', 'task1', 'transition', 'in_progress', 'human_review')`,
    ).run();

    mockClaudeOk('Agent ran ls and transitioned to human review.');

    await summarizeAgentProgress('task1', 'agent1');

    const claudeCalls = mockedExecFile.mock.calls.filter((c) => c[0] === 'claude');
    expect(claudeCalls).toHaveLength(1);
    const args = claudeCalls[0][1] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('--model');
    expect(args).toContain('haiku');
    expect(args).toContain('--tools');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
    // The transcript is concatenated into the positional prompt (last arg)
    const promptArg = args[args.length - 1];
    expect(promptArg).toContain('ls -la');
  });
});

describe('C3: Stop hook calls summarizeAgentProgress when enabled', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();

    insertTask(db, { id: 't1', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, {
      id: 'a1',
      task_id: 't1',
      harness_session_id: 'sess-sum',
      hook_token: 'tok-sum',
      status: 'running',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('does NOT call Haiku when builtin is disabled (no row = disabled)', async () => {
    // No hook_settings row → builtin disabled by default
    await request(app)
      .post('/api/hooks/stop?token=tok-sum')
      .send({ session_id: 'sess-sum' })
      .expect(200);
    // Give the void fire-and-forget a tick to run
    await new Promise((r) => setTimeout(r, 50));
    const claudeCalls = mockedExecFile.mock.calls.filter((c) => c[0] === 'claude');
    expect(claudeCalls).toHaveLength(0);
  });
});
