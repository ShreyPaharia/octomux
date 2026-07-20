import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { getDb } from '../db.js';

const mockStartTask = vi.fn();
vi.mock('../task-engine/index.js', () => ({
  startTask: vi.fn((...args: unknown[]) => mockStartTask(...args)),
}));

const mockStartLoop = vi.fn().mockResolvedValue(undefined);
vi.mock('../task-engine/loop/engine.js', () => ({
  startLoop: vi.fn((...args: unknown[]) => mockStartLoop(...args)),
}));

const mockBroadcast = vi.fn();
vi.mock('../events.js', () => ({
  broadcast: vi.fn((...args: unknown[]) => mockBroadcast(...args)),
}));

// ─── Import after mocks — side-effect registers the workflow + schedule handler ──

import { upsertSchedule } from '../repositories/schedules.js';
import { pollSchedules } from '../poller/schedule-cron.js';
import './index.js';

function insertActiveAgent(taskId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agents (id, task_id, window_index, label, status, harness_id, hook_token)
       VALUES (?, ?, 0, 'Agent 1', 'running', 'claude-code', 'tok')`,
    )
    .run(`${taskId}-agent`, taskId);
}

describe('cron -> prod-log-triage e2e', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    mockStartTask.mockImplementation(async (task: { id: string }) => {
      insertActiveAgent(task.id);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fires a due schedule through the full cron -> service -> loop path', async () => {
    upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T07:00:00Z');

    await pollSchedules(now);

    const tasks = getDb()
      .prepare(`SELECT id, source FROM tasks WHERE source = 'prod_log_triage'`)
      .all() as Array<{ id: string; source: string }>;
    expect(tasks).toHaveLength(1);

    expect(mockStartTask).toHaveBeenCalledTimes(1);
    expect(mockStartLoop).toHaveBeenCalledTimes(1);
    expect(mockStartLoop).toHaveBeenCalledWith(
      tasks[0].id,
      expect.objectContaining({
        verify: expect.any(String),
        maxIterations: expect.any(Number),
        runId: expect.any(String),
      }),
      undefined,
      expect.any(String),
    );
  });
});
