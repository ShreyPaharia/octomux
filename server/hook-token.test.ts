import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, insertTask, insertAgent, DEFAULTS } from './test-helpers.js';
import { ensureHookToken } from './hook-token.js';
import { getDb } from './db.js';
import type { Agent } from './types.js';

// Stub the harness's installHooks so the test doesn't write real files.
vi.mock('./harnesses/index.js', async () => {
  const actual = await vi.importActual<typeof import('./harnesses/index.js')>(
    './harnesses/index.js',
  );
  return {
    ...actual,
    getHarness: () => ({
      ...actual.getHarness('claude-code'),
      installHooks: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    task_id: null,
    window_index: 0,
    label: 'Agent 1',
    status: 'running',
    harness_id: 'claude-code',
    harness_session_id: 'sess-1',
    hook_token: '',
    hook_activity: 'active',
    hook_activity_updated_at: null,
    tmux_session: null,
    agent: null,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('ensureHookToken', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('mints a token for a standalone agent (no task_id) with empty hook_token', async () => {
    insertAgent(getDb(), { id: 'a1', task_id: null, hook_token: '' });
    const agent = makeAgent();
    const token = await ensureHookToken(agent, null);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const row = getDb().prepare(`SELECT hook_token FROM agents WHERE id = 'a1'`).get() as {
      hook_token: string;
    };
    expect(row.hook_token).toBe(token);
  });

  it('returns existing token unchanged', async () => {
    insertAgent(getDb(), { id: 'a2', task_id: null, hook_token: 'tok-existing' });
    const agent = makeAgent({ id: 'a2', hook_token: 'tok-existing' });
    const token = await ensureHookToken(agent, null);
    expect(token).toBe('tok-existing');
  });

  it('skips agents belonging to an idle (closed) task', async () => {
    // In this schema there is no 'closed' runtime_state value.
    // closeTask() sets runtime_state = 'idle', so that is the gate.
    insertTask(getDb(), { ...DEFAULTS.task, id: 't1', runtime_state: 'idle' });
    insertAgent(getDb(), { id: 'a3', task_id: 't1', hook_token: '' });
    const agent = makeAgent({ id: 'a3', task_id: 't1' });
    const token = await ensureHookToken(agent, null);
    expect(token).toBe('');
    // DB row should still have empty token — no write occurred.
    const row = getDb().prepare(`SELECT hook_token FROM agents WHERE id = 'a3'`).get() as {
      hook_token: string;
    };
    expect(row.hook_token).toBe('');
  });

  it('mints a token for an agent whose task is actively running', async () => {
    insertTask(getDb(), { ...DEFAULTS.runningTask, id: 't2', runtime_state: 'running' });
    insertAgent(getDb(), { id: 'a4', task_id: 't2', hook_token: '' });
    const agent = makeAgent({ id: 'a4', task_id: 't2' });
    const token = await ensureHookToken(agent, null);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const row = getDb().prepare(`SELECT hook_token FROM agents WHERE id = 'a4'`).get() as {
      hook_token: string;
    };
    expect(row.hook_token).toBe(token);
  });
});
