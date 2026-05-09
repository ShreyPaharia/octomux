/**
 * C3: Tests for server/summarize.ts + integration with hooks Stop handler.
 *
 * Covers: no-key fallback, builtin-disabled fallback, success path, error swallowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';
import { createApp } from './app.js';

// ─── SDK Mock ────────────────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
  isHookEnabled: vi.fn(() => true),
  invalidateHookEnabledCache: vi.fn(),
}));

// ─── Import the module under test (no resetModules needed) ────────────────────
import { summarizeAgentProgress } from './summarize.js';

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('C3: summarizeAgentProgress', () => {
  let db: Database.Database;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
    db.close();
  });

  it('does nothing when builtin hook is disabled (missing row = disabled)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // No hook_settings row → defaults to disabled for builtin
    await summarizeAgentProgress('task1', 'agent1');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does nothing when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    enableBuiltin(db, true);
    await summarizeAgentProgress('task1', 'agent1');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('writes summary to DB on success', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    enableBuiltin(db, true);

    insertTask(db, { id: 'task1', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, { id: 'agent1', task_id: 'task1', status: 'running' });

    // Add some task_updates so transcript is non-empty
    db.prepare(
      `INSERT INTO task_updates (id, task_id, agent_id, kind, body) VALUES ('u1', 'task1', 'agent1', 'summary', 'Read server/api.ts')`,
    ).run();

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Implemented hook registry endpoints.' }],
    });

    await summarizeAgentProgress('task1', 'agent1');

    const summary = getTaskSummary(db, 'task1');
    expect(summary).toBe('Implemented hook registry endpoints.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('swallows SDK errors — never throws', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    enableBuiltin(db, true);

    insertTask(db, { id: 'task1', runtime_state: 'running', workflow_status: 'in_progress' });
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, body) VALUES ('u1', 'task1', 'summary', 'Did something')`,
    ).run();

    mockCreate.mockRejectedValueOnce(new Error('Rate limited'));

    await expect(summarizeAgentProgress('task1', 'agent1')).resolves.toBeUndefined();
    expect(getTaskSummary(db, 'task1')).toBeNull(); // unchanged
  });

  it('truncates summary to 120 chars', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    enableBuiltin(db, true);

    insertTask(db, { id: 'task1', runtime_state: 'running', workflow_status: 'in_progress' });
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, body) VALUES ('u1', 'task1', 'summary', 'content')`,
    ).run();

    const longText = 'A'.repeat(200);
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: longText }],
    });

    await summarizeAgentProgress('task1', 'agent1');

    const summary = getTaskSummary(db, 'task1');
    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(120);
  });

  it('builds transcript from task_updates', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    enableBuiltin(db, true);

    insertTask(db, { id: 'task1', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, { id: 'agent1', task_id: 'task1', status: 'running' });

    // Multiple task_updates entries
    db.prepare(
      `INSERT INTO task_updates (id, task_id, agent_id, kind, body) VALUES ('u1', 'task1', 'agent1', 'summary', 'Called Bash: ls -la')`,
    ).run();
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, from_status, to_status) VALUES ('u2', 'task1', 'transition', 'in_progress', 'human_review')`,
    ).run();

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Agent ran ls and transitioned to human review.' }],
    });

    await summarizeAgentProgress('task1', 'agent1');

    // Verify mockCreate was called with a non-empty transcript
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArg = mockCreate.mock.calls[0][0];
    const messageContent = callArg.messages[0].content[0].text as string;
    expect(messageContent).toContain('ls -la');
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
    insertAgent(db, { id: 'a1', task_id: 't1', claude_session_id: 'sess-sum', status: 'running' });
  });

  afterEach(() => {
    db.close();
  });

  it('does NOT call Haiku when builtin is disabled (no row = disabled)', async () => {
    // No hook_settings row → builtin disabled by default
    await request(app).post('/api/hooks/stop').send({ session_id: 'sess-sum' }).expect(200);
    // Give the void fire-and-forget a tick to run
    await new Promise((r) => setTimeout(r, 50));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does NOT call Haiku when API key is missing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    enableBuiltin(db, true);
    try {
      await request(app).post('/api/hooks/stop').send({ session_id: 'sess-sum' }).expect(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
