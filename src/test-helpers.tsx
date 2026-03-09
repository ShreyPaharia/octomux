import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Task, TaskStatus } from '../server/types';

// ─── Default Fixtures ────────────────────────────────────────────────────────

export const TASK_DEFAULTS: Task = {
  id: 'test-task-01',
  title: 'Fix order validation',
  description: 'Add negative quantity checks',
  repo_path: '/Users/dev/projects/my-repo',
  status: 'running',
  branch: 'agents/test-task-01',
  worktree: '/Users/dev/projects/my-repo/.worktrees/test-task-01',
  tmux_session: 'octomux-agent-test-task-01',
  pr_url: null,
  pr_number: null,
  error: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

export function makeTask(overrides: Partial<Task> = {}): Task {
  return { ...TASK_DEFAULTS, ...overrides };
}

export const TASK_STATUSES: TaskStatus[] = [
  'created',
  'setting_up',
  'running',
  'done',
  'cancelled',
  'error',
];

// ─── Router-Wrapped Render ───────────────────────────────────────────────────

export function renderWithRouter(
  ui: ReactElement,
  { route = '/', ...options }: RenderOptions & { route?: string } = {},
) {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>, options);
}

// ─── API Mock Helpers ────────────────────────────────────────────────────────

export function mockApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    createTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    updateTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    addAgent: vi.fn().mockResolvedValue({
      id: 'a1',
      task_id: 'test-task-01',
      window_index: 0,
      label: 'Agent 1',
      status: 'running',
      created_at: '',
    }),
    stopAgent: vi.fn().mockResolvedValue(undefined),
  };
  return { ...defaults, ...overrides };
}
