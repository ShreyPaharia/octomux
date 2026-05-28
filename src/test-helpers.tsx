import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Task, Agent } from '../server/types';

// ─── Default Fixtures ────────────────────────────────────────────────────────

export const AGENT_DEFAULTS: Agent = {
  id: 'agent-01',
  task_id: 'test-task-01',
  window_index: 0,
  label: 'Agent 1',
  status: 'running',
  harness_id: 'claude-code',
  harness_session_id: null,
  hook_token: '',
  hook_activity: 'active',
  hook_activity_updated_at: null,
  tmux_session: null,
  agent: null,
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
  runtime_state: 'running',
  workflow_status: 'in_progress',
  branch: 'agents/test-task-01',
  base_branch: null,
  worktree: '/Users/dev/projects/my-repo/.worktrees/test-task-01',
  tmux_session: 'octomux-agent-test-task-01',
  pr_url: null,
  pr_number: null,
  pr_head_sha: null,
  user_window_index: null,
  initial_prompt: null,
  run_mode: 'new',
  base_sha: null,
  last_viewed_at: null,
  deleted_at: null,
  source: null,
  worktree_id: null,
  harness_id: 'claude-code',
  agent: null,
  error: null,
  current_summary: null,
  current_summary_updated_at: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

export function makeTask(overrides: Partial<Task> = {}): Task {
  return { ...TASK_DEFAULTS, ...overrides };
}

/** @deprecated status column was removed in Wave 4; use runtime_state directly */
export const TASK_STATUSES: string[] = ['idle', 'setting_up', 'running', 'error'];

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

/**
 * Builds an `apiMock` (vi.fn stubs with sensible defaults) and an `apiProxy` that
 * forwards property reads to it. Intended to be called from inside `vi.hoisted()`:
 *
 *   const { apiMock, apiProxy } = await vi.hoisted(
 *     async () => (await import('../test-helpers')).setupApiMock(),
 *   );
 *   vi.mock('@/lib/api', () => ({ api: apiProxy }));
 *
 * `vi.hoisted()` runs before any imports or `vi.mock` factories, so both `apiMock`
 * and `apiProxy` are initialized by the time the `vi.mock` factory is invoked —
 * avoiding the TDZ that a plain top-level `const apiMock = mockApi()` hits.
 */
/**
 * Builds a `mockNavigate` vi.fn() and returns a `react-router-dom` factory suitable
 * for passing directly to `vi.mock`. Use inside `vi.hoisted()`:
 *
 *   const { mockNavigate, routerMockFactory } = await vi.hoisted(
 *     async () => (await import('../test-helpers')).setupRouterNavigateMock(),
 *   );
 *   vi.mock('react-router-dom', routerMockFactory);
 */
export function setupRouterNavigateMock() {
  const mockNavigate = vi.fn();
  const routerMockFactory = async (importOriginal: () => Promise<unknown>) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, useNavigate: () => mockNavigate };
  };
  return { mockNavigate, routerMockFactory };
}

export function setupApiMock(overrides: Record<string, unknown> = {}) {
  const apiMock = mockApi(overrides);
  const apiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock] },
  );
  return { apiMock, apiProxy };
}

export function mockApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    getInbox: vi.fn().mockResolvedValue({ needs_you: [], activity: [] }),
    markTaskViewed: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    markAllTasksViewed: vi.fn().mockResolvedValue({ updated: 0 }),
    createTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    updateTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    startTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    deleteTask: vi.fn().mockResolvedValue(undefined), // accepts optional opts: { purge?: boolean }
    getTaskDiffSummary: vi.fn().mockResolvedValue({ files: [] }),
    createPr: vi.fn().mockResolvedValue({ ok: true }),
    getTaskDiffFile: vi.fn().mockResolvedValue({
      oldContent: '',
      newContent: '',
      status: 'M',
      tooLarge: false,
      binary: false,
    }),
    addAgent: vi.fn().mockResolvedValue({
      id: 'a1',
      task_id: 'test-task-01',
      window_index: 0,
      label: 'Agent 1',
      status: 'running',
      created_at: '',
    }),
    stopAgent: vi.fn().mockResolvedValue(undefined),
    createUserTerminal: vi.fn().mockResolvedValue({ editor: 'nvim', windowIndex: 5 }),
    createTerminal: vi.fn().mockResolvedValue({
      id: 'term-1',
      task_id: 'test-task-01',
      window_index: 3,
      label: 'Terminal 1',
      status: 'idle',
      created_at: '',
    }),
    closeTerminal: vi.fn().mockResolvedValue(undefined),
    markReviewed: vi.fn().mockResolvedValue(undefined),
    unmarkReviewed: vi.fn().mockResolvedValue(undefined),
    sendAgentMessage: vi.fn().mockResolvedValue({ ok: true }),
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    recentRepos: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
    preflightNoneMode: vi.fn().mockResolvedValue({
      ok: true,
      currentBranch: 'main',
      targetBranch: 'main',
      conflicts: [],
      warnings: [],
      dirty: null,
    }),
    stashRepo: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),
    getSkill: vi.fn().mockResolvedValue({ name: 'test-skill', content: '# Test' }),
    createSkill: vi.fn().mockResolvedValue({ name: 'test-skill', content: '# Test' }),
    updateSkill: vi.fn().mockResolvedValue({ name: 'test-skill', content: '# Updated' }),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
    closeChat: vi.fn().mockResolvedValue(undefined),
    deleteChat: vi.fn().mockResolvedValue(undefined),
    listTaskBranches: vi.fn().mockResolvedValue({ branches: [], current: null, default: null }),
    listTaskCommits: vi.fn().mockResolvedValue({ commits: [], truncated: false }),
    updateTaskBase: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    postComment: vi.fn().mockResolvedValue({
      id: 'c1',
      task_id: 'test-task-01',
      agent_id: null,
      file_path: 'src/foo.ts',
      line: 1,
      side: 'new',
      original_commit_sha: '0000000',
      body: 'mock comment',
      created_at: '2026-01-01 00:00:00',
      resolved_at: null,
    }),
    listComments: vi.fn().mockResolvedValue({ comments: [] }),
    updateComment: vi.fn().mockResolvedValue({
      id: 'c1',
      task_id: 'test-task-01',
      agent_id: null,
      file_path: 'src/foo.ts',
      line: 1,
      side: 'new',
      original_commit_sha: '0000000',
      body: 'mock comment',
      created_at: '2026-01-01 00:00:00',
      resolved_at: null,
    }),
    deleteComment: vi.fn().mockResolvedValue(undefined),
    listIntegrations: vi.fn().mockResolvedValue([]),
    deleteDone: vi.fn().mockResolvedValue({ deleted: 0 }),
    restoreTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    postTaskSummary: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    postTaskNote: vi.fn().mockResolvedValue({
      id: 'u1',
      task_id: 'test-task-01',
      agent_id: null,
      kind: 'note' as const,
      from_status: null,
      to_status: null,
      body: 'test note',
      created_at: '2026-01-01 00:00:00',
    }),
    addTaskRef: vi.fn().mockResolvedValue({
      task_id: 'test-task-01',
      integration: 'jira',
      ref: 'PROJ-1',
      url: null,
      created_at: '2026-01-01 00:00:00',
    }),
    deleteTaskRef: vi.fn().mockResolvedValue(undefined),
    getTaskUpdates: vi.fn().mockResolvedValue([]),
    getTaskRefs: vi.fn().mockResolvedValue([]),
    getTaskHookExecutions: vi.fn().mockResolvedValue([]),
    getHooksRegistry: vi.fn().mockResolvedValue({ hooks: [] }),
    updateHookEnabled: vi
      .fn()
      .mockResolvedValue({ scope: 'builtin', key: 'summarize-progress', enabled: true }),
    listReviewsInbox: vi.fn().mockResolvedValue([]),
    getReviewDetail: vi.fn().mockResolvedValue(null),
    patchComment: vi.fn().mockResolvedValue({ id: 'c1', status: 'accepted' }),
    patchWalkthrough: vi.fn().mockResolvedValue({ walkthrough: '{}' }),
    publishReview: vi.fn().mockResolvedValue({ publishedReviewId: 'pr1', commentCount: 0 }),
    requestReReview: vi.fn().mockResolvedValue({ ok: true }),
    getSettings: vi.fn().mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      defaultHarnessId: 'claude-code',
      harnesses: {},
      envOverrides: { claudeFlags: null },
    }),
    updateSettings: vi.fn().mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      defaultHarnessId: 'claude-code',
      harnesses: {},
      envOverrides: { claudeFlags: null },
    }),
    listHarnesses: vi.fn().mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', sessionIdMode: 'orchestrator-assigned' },
      { id: 'cursor', displayName: 'Cursor', sessionIdMode: 'harness-issued' },
    ]),
  };
  return { ...defaults, ...overrides };
}
