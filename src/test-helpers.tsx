import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Task, TaskStatus, Agent } from '../server/types';

// ─── Default Fixtures ────────────────────────────────────────────────────────

export const AGENT_DEFAULTS: Agent = {
  id: 'agent-01',
  task_id: 'test-task-01',
  window_index: 0,
  label: 'Agent 1',
  status: 'running',
  claude_session_id: null,
  created_at: '2026-01-01 00:00:00',
};

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return { ...AGENT_DEFAULTS, ...overrides };
}

export const TASK_DEFAULTS: Task = {
  id: 'test-task-01',
  title: 'Fix order validation',
  description: 'Add negative quantity checks',
  repo_path: '/Users/dev/projects/my-repo',
  status: 'running',
  branch: 'agents/test-task-01',
  base_branch: null,
  worktree: '/Users/dev/projects/my-repo/.worktrees/test-task-01',
  tmux_session: 'octomux-agent-test-task-01',
  pr_url: null,
  pr_number: null,
  initial_prompt: null,
  error: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

export function makeTask(overrides: Partial<Task> = {}): Task {
  return { ...TASK_DEFAULTS, ...overrides };
}

export const TASK_STATUSES: TaskStatus[] = ['draft', 'setting_up', 'running', 'closed', 'error'];

// ─── Router-Wrapped Render ───────────────────────────────────────────────────

export function renderWithRouter(
  ui: ReactElement,
  { route = '/', path, ...options }: RenderOptions & { route?: string; path?: string } = {},
) {
  if (path) {
    return render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={ui} />
        </Routes>
      </MemoryRouter>,
      options,
    );
  }
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>, options);
}

// ─── API Mock Helpers ────────────────────────────────────────────────────────

export function mockApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    createTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    updateTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    startTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
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
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    recentRepos: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
    previewPR: vi.fn().mockResolvedValue({ title: '', body: '', base: 'main' }),
    createPR: vi.fn().mockResolvedValue(TASK_DEFAULTS),
  };
  return { ...defaults, ...overrides };
}
