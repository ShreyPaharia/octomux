import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../../sqlite.js';
import { describe, it, expect, beforeEach, afterEach, vi } from '../../bun-test.js';
import type { Task, Worker } from '../../types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────
//
// `fs` is intentionally NOT mocked: buildAgentStartupCommand now writes the
// prompt file through `localSession.files` (real `fs.promises`), same
// real-fs pattern as `launch.test.ts`. Only `child_process` (tmux) is mocked.

let nextWindowIndex = 5;

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, args: string[], optsOrCb: Function | object, maybeCb?: Function) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (args.includes('list-windows') || args.includes('display-message')) {
        cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      } else if (args.includes('new-window')) {
        nextWindowIndex++;
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    },
  ),
}));

vi.mock('../../repositories/orchestrator.js', (importOriginal) => {
  const actual = importOriginal<typeof import('../../repositories/orchestrator.js')>();
  return { ...actual, isOrchestratorManaged: vi.fn(() => false) };
});

vi.mock('../../orchestrator/runner.js', () => ({
  mcpServerInvocation: vi.fn(() => null),
}));

vi.mock('../../hook-base-url.js', () => ({
  hookBaseUrl: vi.fn(() => 'http://127.0.0.1:7777'),
}));

vi.mock('../../settings.js', () => ({
  getSettings: vi.fn(async () => ({})),
}));

vi.mock('../../events.js', () => ({
  broadcast: vi.fn(),
}));

const newSessionId = vi.fn(() => 'fresh-session-id');
const buildLaunchCommand = vi.fn(() => 'claude --session-id fresh-session-id');
const buildResumeCommand = vi.fn(() => 'claude --resume old-session');

vi.mock('../../harnesses/index.js', () => ({
  getHarness: vi.fn(() => ({
    id: 'claude-code',
    sessionIdMode: 'orchestrator-assigned',
    newSessionId,
    buildLaunchCommand,
    buildResumeCommand,
    resolveFlags: vi.fn(() => ''),
    syncAgents: vi.fn(async () => undefined),
    installHooks: vi.fn(async () => undefined),
    postLaunch: vi.fn(async () => undefined),
  })),
}));

const { createTestDb, insertTask, insertAgent, DEFAULTS } = await import('../../test-helpers.js');

const { respawnAgentFresh } = await import('./respawn-agent.js');
const { execFile } = await import('child_process');
const { broadcast } = await import('../../events.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database;
let worktreeDir: string;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  nextWindowIndex = 5;
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-respawn-test-'));
  insertTask(db, { ...DEFAULTS.runningTask, worktree: worktreeDir });
});

afterEach(() => {
  fs.rmSync(worktreeDir, { recursive: true, force: true });
});

function makeAgentRow(overrides: Partial<Worker> = {}): Worker {
  return insertAgent(db, {
    ...DEFAULTS.agent,
    window_index: 1,
    harness_session_id: 'old-session-id',
    ...overrides,
  });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return { ...DEFAULTS.runningTask, worktree: worktreeDir, ...overrides } as Task;
}

// ─── respawnAgentFresh ────────────────────────────────────────────────────────

describe('respawnAgentFresh', () => {
  it('issues tmux new-window before any kill-window', async () => {
    const agent = makeAgentRow();
    const task = makeTask();

    await respawnAgentFresh(task, agent);

    const calls = vi.mocked(execFile).mock.calls;
    const newWindowIdx = calls.findIndex((c) => (c[1] as string[])?.includes('new-window'));
    const killWindowIdx = calls.findIndex((c) => (c[1] as string[])?.includes('kill-window'));
    expect(newWindowIdx).toBeGreaterThanOrEqual(0);
    expect(killWindowIdx).toBeGreaterThan(newWindowIdx);
  });

  it('launches with a fresh session id and does not resume', async () => {
    const agent = makeAgentRow();
    const task = makeTask();

    await respawnAgentFresh(task, agent);

    expect(newSessionId).toHaveBeenCalled();
    expect(buildLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'fresh-session-id' }),
    );
    expect(buildResumeCommand).not.toHaveBeenCalled();
  });

  it('returns an agent whose harness_session_id differs from the input', async () => {
    const agent = makeAgentRow();
    const task = makeTask();

    const result = await respawnAgentFresh(task, agent);

    expect(result.harness_session_id).not.toBe(agent.harness_session_id);
    expect(result.harness_session_id).toBe('fresh-session-id');
  });

  it('keeps the same task_id on the returned agent', async () => {
    const agent = makeAgentRow();
    const task = makeTask();

    const result = await respawnAgentFresh(task, agent);

    expect(result.task_id).toBe(task.id);
  });

  it('broadcasts a task:updated event', async () => {
    const agent = makeAgentRow();
    const task = makeTask();

    await respawnAgentFresh(task, agent);

    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:updated',
      payload: { taskId: task.id },
    });
  });

  it('creates the new window in the task tmux_session, not a new session', async () => {
    const agent = makeAgentRow();
    const task = makeTask();

    await respawnAgentFresh(task, agent);

    const newSessionCall = vi
      .mocked(execFile)
      .mock.calls.find((c) => (c[1] as string[])?.includes('new-session'));
    expect(newSessionCall).toBeUndefined();
  });

  it('passes opts.prompt through to the startup command as a prompt file', async () => {
    const agent = makeAgentRow();
    const task = makeTask();

    await respawnAgentFresh(task, agent, { prompt: 'do the loop thing' });

    const promptFile = path.join(worktreeDir, `.claude-prompt-${agent.id}`);
    expect(fs.readFileSync(promptFile, 'utf-8')).toContain('do the loop thing');
  });

  it('exposes a hook token in the startup env that checkAgentTokenExists accepts (loop emit auth)', async () => {
    const agent = makeAgentRow({ hook_token: 'real-hook-token-abc' });
    const task = makeTask();

    await respawnAgentFresh(task, agent, {
      env: {
        OCTOMUX_TASK_ID: task.id,
        OCTOMUX_ACTION_TOKEN: agent.hook_token,
        OCTOMUX_ACTION_BASE_URL: 'http://127.0.0.1:7777',
      },
    });

    const newWindowCall = vi
      .mocked(execFile)
      .mock.calls.find((c) => (c[1] as string[])?.includes('new-window'));
    const startupCmd = (newWindowCall![1] as string[]).at(-1) as string;
    expect(startupCmd).toContain('OCTOMUX_ACTION_TOKEN=');
    expect(startupCmd).toContain('real-hook-token-abc');

    const { checkAgentTokenExists } = await import('../../repositories/workers.js');
    expect(checkAgentTokenExists('real-hook-token-abc')).toBe(true);
  });

  it('opts.fresh=true creates a brand-new tmux session instead of a window, and never kill-windows', async () => {
    const agent = makeAgentRow();
    const task = makeTask();

    await respawnAgentFresh(task, agent, { fresh: true });

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls.some((c) => (c[1] as string[])?.includes('new-session'))).toBe(true);
    expect(calls.some((c) => (c[1] as string[])?.includes('new-window'))).toBe(false);
    expect(calls.some((c) => (c[1] as string[])?.includes('kill-window'))).toBe(false);
  });
});
