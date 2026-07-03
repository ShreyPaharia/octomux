import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createTestDb, insertTask, DEFAULTS } from '../../test-helpers.js';
import type { Task } from '../../types.js';

vi.mock('../harnesses/index.js', () => ({
  getHarness: vi.fn(() => ({
    id: 'claude-code',
    resolveFlags: vi.fn(() => []),
    syncAgents: vi.fn(async () => undefined),
    installHooks: vi.fn(async () => undefined),
    buildLaunchCommand: vi.fn(() => 'claude'),
    postLaunch: vi.fn(),
  })),
}));

vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({})),
}));

vi.mock('../skills.js', () => ({
  syncSkills: vi.fn(async () => undefined),
}));

const { validateAndResolveAddAgentOpts } = await import('./add-agent.js');

let db: Database.Database;
let worktreePath: string;

beforeEach(() => {
  db = createTestDb();
  worktreePath = path.join('/tmp', `octomux-add-agent-test-${Date.now()}`);
  fs.mkdirSync(path.join(worktreePath, '.octomux', 'agents'), { recursive: true });
  insertTask(db, {
    ...DEFAULTS.runningTask,
    worktree: worktreePath,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(worktreePath, { recursive: true, force: true });
});

describe('validateAndResolveAddAgentOpts', () => {
  it('defaults label to Agent N based on active agent count', () => {
    const task = { ...DEFAULTS.runningTask, worktree: worktreePath } as Task;
    const resolved = validateAndResolveAddAgentOpts(task);
    expect(resolved.label).toBe('Agent 1');
  });

  it('merges skeleton content with prompt', () => {
    const skeletonPath = path.join(worktreePath, '.octomux', 'agents', 'researcher.md');
    fs.writeFileSync(skeletonPath, '# Researcher role');
    const task = { ...DEFAULTS.runningTask, worktree: worktreePath } as Task;
    const resolved = validateAndResolveAddAgentOpts(task, {
      skeleton: 'researcher',
      prompt: 'Find bugs',
    });
    expect(resolved.resolvedPrompt).toContain('# Researcher role');
    expect(resolved.resolvedPrompt).toContain('Find bugs');
  });

  it('throws when skeleton file is missing', () => {
    const task = { ...DEFAULTS.runningTask, worktree: worktreePath } as Task;
    expect(() => validateAndResolveAddAgentOpts(task, { skeleton: 'missing' })).toThrow(
      /skeleton not found/,
    );
  });
});
