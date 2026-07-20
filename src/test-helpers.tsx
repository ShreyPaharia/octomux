import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Task, Agent } from '@octomux/types';
import {
  FRONTEND_AGENT_DEFAULTS,
  FRONTEND_TASK_DEFAULTS,
  makeAgent as makeAgentFixture,
  makeTask as makeTaskFixture,
} from '@octomux/test-fixtures';

// ─── Default Fixtures ────────────────────────────────────────────────────────

export const AGENT_DEFAULTS = FRONTEND_AGENT_DEFAULTS;
export const TASK_DEFAULTS = FRONTEND_TASK_DEFAULTS;

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return makeAgentFixture(overrides);
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return makeTaskFixture(overrides);
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

/**
 * Builds namespaced API mocks for vitest. Intended to be called from inside
 * `vi.hoisted()`:
 *
 *   const { taskApiMock, taskApiProxy, reviewApiMock, reviewApiProxy,
 *           configApiMock, configApiProxy, apiMock } = await vi.hoisted(
 *     async () => (await import('../test-helpers')).setupApiMock(),
 *   );
 *   vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
 *   vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
 *   vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
 */
type ApiMock = ReturnType<typeof mockTaskApi> &
  ReturnType<typeof mockReviewApi> &
  ReturnType<typeof mockConfigApi> &
  ReturnType<typeof mockLoopApi> &
  ReturnType<typeof mockExtractApi> &
  ReturnType<typeof mockLoopGroupApi> &
  ReturnType<typeof mockSchedulesApi> &
  ReturnType<typeof mockWorkflowsApi> &
  Record<string, unknown>;

export function setupApiMock(overrides: Record<string, unknown> = {}) {
  const taskApiMock = mockTaskApi(overrides);
  const reviewApiMock = mockReviewApi(overrides);
  const configApiMock = mockConfigApi(overrides);
  const loopApiMock = mockLoopApi(overrides);
  const extractApiMock = mockExtractApi(overrides);
  const loopGroupApiMock = mockLoopGroupApi(overrides);
  const schedulesApiMock = mockSchedulesApi(overrides);
  const workflowsApiMock = mockWorkflowsApi(overrides);
  const taskApiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => taskApiMock[prop as keyof typeof taskApiMock] },
  );
  const reviewApiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => reviewApiMock[prop as keyof typeof reviewApiMock] },
  );
  const configApiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => configApiMock[prop as keyof typeof configApiMock] },
  );
  const loopApiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => loopApiMock[prop as keyof typeof loopApiMock] },
  );
  const extractApiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => extractApiMock[prop as keyof typeof extractApiMock] },
  );
  const loopGroupApiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => loopGroupApiMock[prop as keyof typeof loopGroupApiMock] },
  );
  const schedulesApiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => schedulesApiMock[prop as keyof typeof schedulesApiMock] },
  );
  const workflowsApiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => workflowsApiMock[prop as keyof typeof workflowsApiMock] },
  );
  const apiMock = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop in taskApiMock) return taskApiMock[prop as keyof typeof taskApiMock];
        if (prop in reviewApiMock) return reviewApiMock[prop as keyof typeof reviewApiMock];
        if (prop in configApiMock) return configApiMock[prop as keyof typeof configApiMock];
        if (prop in loopApiMock) return loopApiMock[prop as keyof typeof loopApiMock];
        if (prop in extractApiMock) return extractApiMock[prop as keyof typeof extractApiMock];
        if (prop in loopGroupApiMock)
          return loopGroupApiMock[prop as keyof typeof loopGroupApiMock];
        if (prop in schedulesApiMock)
          return schedulesApiMock[prop as keyof typeof schedulesApiMock];
        if (prop in workflowsApiMock)
          return workflowsApiMock[prop as keyof typeof workflowsApiMock];
        return overrides[prop];
      },
      set: (_target, prop: string, value) => {
        if (prop in taskApiMock) {
          (taskApiMock as Record<string, unknown>)[prop] = value;
          return true;
        }
        if (prop in reviewApiMock) {
          (reviewApiMock as Record<string, unknown>)[prop] = value;
          return true;
        }
        if (prop in configApiMock) {
          (configApiMock as Record<string, unknown>)[prop] = value;
          return true;
        }
        if (prop in loopApiMock) {
          (loopApiMock as Record<string, unknown>)[prop] = value;
          return true;
        }
        if (prop in extractApiMock) {
          (extractApiMock as Record<string, unknown>)[prop] = value;
          return true;
        }
        if (prop in loopGroupApiMock) {
          (loopGroupApiMock as Record<string, unknown>)[prop] = value;
          return true;
        }
        if (prop in schedulesApiMock) {
          (schedulesApiMock as Record<string, unknown>)[prop] = value;
          return true;
        }
        if (prop in workflowsApiMock) {
          (workflowsApiMock as Record<string, unknown>)[prop] = value;
          return true;
        }
        overrides[prop] = value;
        return true;
      },
    },
  ) as ApiMock;
  const apiProxy = new Proxy(
    {},
    { get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock] },
  );
  return {
    taskApiMock,
    reviewApiMock,
    configApiMock,
    loopApiMock,
    extractApiMock,
    loopGroupApiMock,
    schedulesApiMock,
    workflowsApiMock,
    taskApiProxy,
    reviewApiProxy,
    configApiProxy,
    loopApiProxy,
    extractApiProxy,
    loopGroupApiProxy,
    schedulesApiProxy,
    workflowsApiProxy,
    apiMock,
    apiProxy,
  };
}

export function mockTaskApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    recentRepos: vi.fn().mockResolvedValue([]),
    getInbox: vi.fn().mockResolvedValue({ needs_you: [], activity: [] }),
    markTaskViewed: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    markAllTasksViewed: vi.fn().mockResolvedValue({ updated: 0 }),
    listBranches: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    createTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    updateTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    startTask: vi.fn().mockResolvedValue(TASK_DEFAULTS),
    deleteTask: vi.fn().mockResolvedValue(undefined),
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
    preflightNoneMode: vi.fn().mockResolvedValue({
      ok: true,
      currentBranch: 'main',
      targetBranch: 'main',
      conflicts: [],
      warnings: [],
      dirty: null,
    }),
    stashRepo: vi.fn().mockResolvedValue(undefined),
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
    moveAgentToTask: vi.fn().mockResolvedValue(makeAgent()),
    listWorktrees: vi.fn().mockResolvedValue([]),
    getWorktree: vi.fn().mockResolvedValue(null),
    deleteWorktree: vi.fn().mockResolvedValue(undefined),
  };
  return { ...defaults, ...overrides };
}

export function mockReviewApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listReviewsInbox: vi.fn().mockResolvedValue([]),
    getReviewDetail: vi.fn().mockResolvedValue(null),
    patchComment: vi.fn().mockResolvedValue({ id: 'c1', status: 'accepted' }),
    patchWalkthrough: vi.fn().mockResolvedValue({ walkthrough: '{}' }),
    publishReview: vi.fn().mockResolvedValue({ publishedReviewId: 'pr1', commentCount: 0 }),
    requestReReview: vi.fn().mockResolvedValue({ ok: true }),
    triggerManualReview: vi.fn().mockResolvedValue({ id: 'rev1', action: 'created' as const }),
    listLearnings: vi.fn().mockResolvedValue([]),
    deleteLearning: vi.fn().mockResolvedValue(undefined),
  };
  return { ...defaults, ...overrides };
}

export function mockConfigApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    getSettings: vi.fn().mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      defaultHarnessId: 'claude-code',
      harnesses: {},
      envOverrides: { claudeFlags: null },
      deleteGraceHours: 6,
    }),
    updateSettings: vi.fn().mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      defaultHarnessId: 'claude-code',
      harnesses: {},
      envOverrides: { claudeFlags: null },
      deleteGraceHours: 6,
    }),
    getSetupStatus: vi.fn().mockResolvedValue({
      items: [],
      summary: { ready: true, blockerCount: 0, attentionCount: 0 },
      platform: 'darwin',
      hasBrew: true,
    }),
    setupInstall: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    applyRecommendedDefaults: vi.fn().mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
    }),
    listHookTemplates: vi.fn().mockResolvedValue([]),
    installHookTemplate: vi.fn().mockResolvedValue({ ok: true, files: [] }),
    listHarnesses: vi.fn().mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', sessionIdMode: 'orchestrator-assigned' },
      { id: 'cursor', displayName: 'Cursor', sessionIdMode: 'harness-issued' },
    ]),
    listSkills: vi.fn().mockResolvedValue([]),
    getSkill: vi.fn().mockResolvedValue({ name: 'test-skill', content: '# Test' }),
    createSkill: vi.fn().mockResolvedValue({ name: 'test-skill', content: '# Test' }),
    updateSkill: vi.fn().mockResolvedValue({ name: 'test-skill', content: '# Updated' }),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    listAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue({
      name: 'test-agent',
      content: '# Test',
      defaultContent: '# Test',
      isCustom: false,
    }),
    saveAgent: vi.fn().mockResolvedValue({
      name: 'test-agent',
      content: '# Test',
      defaultContent: '# Test',
      isCustom: true,
    }),
    resetAgent: vi.fn().mockResolvedValue({ ok: true }),
    createAgent: vi.fn().mockResolvedValue({
      name: 'test-agent',
      content: '# Test',
      defaultContent: '# Test',
      isCustom: true,
    }),
    deleteAgent: vi.fn().mockResolvedValue({ ok: true }),
    listRepoConfigs: vi.fn().mockResolvedValue([]),
    getRepoConfig: vi.fn().mockResolvedValue(null),
    updateRepoConfig: vi.fn().mockResolvedValue(null),
    listProviders: vi.fn().mockResolvedValue([]),
    listIntegrations: vi.fn().mockResolvedValue([]),
    createIntegration: vi.fn().mockResolvedValue({
      id: 'int-1',
      kind: 'jira',
      name: 'Jira',
      config: {},
      enabled: true,
      created_at: '',
      updated_at: '',
    }),
    updateIntegration: vi.fn().mockResolvedValue({
      id: 'int-1',
      kind: 'jira',
      name: 'Jira',
      config: {},
      enabled: true,
      created_at: '',
      updated_at: '',
    }),
    deleteIntegration: vi.fn().mockResolvedValue(undefined),
    testIntegration: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    prefillLinear: vi.fn().mockResolvedValue({
      teams: [],
      status_map_by_team: {},
      default_team_suggestion: null,
    }),
    getHooksRegistry: vi.fn().mockResolvedValue({ hooks: [] }),
    updateHookEnabled: vi
      .fn()
      .mockResolvedValue({ scope: 'builtin', key: 'summarize-progress', enabled: true }),
  };
  return { ...defaults, ...overrides };
}

export function mockLoopApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listLoops: vi.fn().mockResolvedValue([]),
    getLoop: vi.fn().mockResolvedValue(null),
    createLoop: vi.fn().mockResolvedValue({
      id: 'loop-1',
      task_id: 'test-task-01',
      spec_json: '{}',
      status: 'running',
      iteration: 0,
      max_iterations: 10,
      budget_json: null,
      termination_reason: null,
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00',
    }),
    stopLoop: vi.fn().mockResolvedValue({ id: 'loop-1', status: 'needs_human' }),
  };
  return { ...defaults, ...overrides };
}

export function mockExtractApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listExtracts: vi.fn().mockResolvedValue([]),
    getExtract: vi.fn().mockResolvedValue(null),
  };
  return { ...defaults, ...overrides };
}

export function mockLoopGroupApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listLoopGroups: vi.fn().mockResolvedValue([]),
    getLoopGroup: vi.fn().mockResolvedValue(null),
    createLoopGroup: vi.fn().mockResolvedValue({
      id: 'group-1',
      spec_json: '{}',
      n: 3,
      repo_path: '/repo',
      base_branch: 'main',
      judge_status: 'not_run',
      winner_loop_run_id: null,
      judge_rationale: null,
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00',
      loopRuns: [],
    }),
    judgeLoopGroup: vi.fn().mockResolvedValue({ id: 'group-1', judge_status: 'running' }),
  };
  return { ...defaults, ...overrides };
}

export function mockSchedulesApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listSchedules: vi.fn().mockResolvedValue([]),
    getScheduleKinds: vi.fn().mockResolvedValue({
      kinds: [
        {
          kind: 'prod-log-triage',
          displayName: 'Prod Log Triage',
          configSchema: null,
        },
      ],
    }),
    createSchedule: vi.fn().mockResolvedValue({
      id: 'sched-1',
      kind: 'prod-log-triage',
      repo_path: '/repo',
      cron: '0 7 * * *',
      enabled: 1,
      last_run_at: null,
      config_json: null,
    }),
    updateSchedule: vi.fn().mockResolvedValue({
      id: 'sched-1',
      kind: 'prod-log-triage',
      repo_path: '/repo',
      cron: '0 7 * * *',
      enabled: 0,
      last_run_at: null,
      config_json: null,
    }),
    deleteSchedule: vi.fn().mockResolvedValue(undefined),
    getScheduleRuns: vi.fn().mockResolvedValue({ runs: [] }),
  };
  return { ...defaults, ...overrides };
}

export function mockWorkflowsApi(overrides: Record<string, unknown> = {}) {
  const defaults = {
    listWorkflows: vi.fn().mockResolvedValue({ workflows: [] }),
    getWorkflowRuns: vi.fn().mockResolvedValue({ runs: [] }),
    listAllRuns: vi.fn().mockResolvedValue({ runs: [] }),
  };
  return { ...defaults, ...overrides };
}

export function mockApi(overrides: Record<string, unknown> = {}) {
  return {
    ...mockTaskApi(),
    ...mockReviewApi(),
    ...mockConfigApi(),
    ...mockLoopApi(),
    ...mockExtractApi(),
    ...mockLoopGroupApi(),
    ...mockSchedulesApi(),
    ...mockWorkflowsApi(),
    ...overrides,
  };
}
