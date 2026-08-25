/**
 * Wiring tests for `ctx.policy` at its four real call sites: `task.launch`
 * (start-task.ts), `harness.resume` (resume-task.ts), `review.publish`
 * (publish-review.ts) and `integration.send` (hook-dispatcher.ts).
 *
 * `server/plugins/policy.ts` is mocked throughout — this file tests that each
 * call site asks the gate, surfaces a deny correctly, and honours a patch on
 * the one key core reads. It does not exercise the policy engine itself.
 */
import { describe, it, expect, vi, beforeEach } from '../../bun-test.js';
import type { Task } from '../../types.js';
import type { HookEnvelope } from '../../hook-types.js';
import type { Integration, IntegrationProvider } from '../../integrations/types.js';
import type { PolicyOutcome } from '../../plugins/policy.js';

// ─── child_process / fs — mocked before anything that captures them ──────────

vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    accessSync: vi.fn(),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
    constants: { X_OK: 1 },
  },
}));

// ─── the policy gate itself — shared mock across all four call sites ─────────

const mockEnforcePolicy = vi.fn(
  async (_point: string, intent: { data: Record<string, unknown> }) => intent.data,
);
const mockEvaluatePolicy = vi.fn(
  async (_point: string, intent: { data: Record<string, unknown> }): Promise<PolicyOutcome> => ({
    allowed: true,
    data: intent.data,
  }),
);
vi.mock('../../plugins/policy.js', () => ({
  enforcePolicy: mockEnforcePolicy,
  evaluatePolicy: mockEvaluatePolicy,
}));

// ─── harnesses ────────────────────────────────────────────────────────────────

const mockBuildLaunchCommand = vi.fn(() => 'claude launch');
const fakeHarness = {
  id: 'claude-code',
  resolveFlags: vi.fn(() => []),
  installHooks: vi.fn(async () => undefined),
  buildLaunchCommand: mockBuildLaunchCommand,
  buildResumeCommand: vi.fn(() => 'claude resume'),
  buildContinueCommand: vi.fn(() => 'claude continue'),
  newSessionId: vi.fn(() => 'new-session-id'),
  postLaunch: vi.fn(),
};
vi.mock('../../harnesses/index.js', () => ({ getHarness: vi.fn(() => fakeHarness) }));

vi.mock('../../hook-base-url.js', () => ({ hookBaseUrl: vi.fn(() => 'http://127.0.0.1:7777') }));
vi.mock('../../repositories/repo-config.js', () => ({
  getOrCreateRepoConfig: vi.fn(async () => ({})),
}));
vi.mock('../../ref-inference.js', () => ({ inferRefs: vi.fn(() => []) }));
vi.mock('../../events.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../harness-flags.js', () => ({ resolveHarnessFlags: vi.fn(async () => []) }));
vi.mock('../../schedule-prompt.js', () => ({
  skillContentOverridesForScheduleId: vi.fn(async () => undefined),
}));

// ─── repositories barrel — union of everything all four sites import ────────

const mockSetRuntimeState = vi.fn();
const mockRunSetupCalls = vi.fn();
vi.mock('../../repositories/index.js', () => ({
  setRuntimeState: mockSetRuntimeState,
  setWorktreeId: vi.fn(),
  setTmuxSession: vi.fn(),
  markTaskRunning: vi.fn(),
  insertTaskExternalRefIfAbsent: vi.fn(),
  updateWorktreeOnSetup: vi.fn(),
  insertWorktreeInUse: vi.fn(() => 'wt-1'),
  insertAgent: vi.fn(() => 'agent-1'),
  updateTaskFields: vi.fn(),
  listStoppedAgents: vi.fn(() => []),
  deleteUserTerminalsByTask: vi.fn(),
  setAgentWindowRunning: vi.fn(),
  stopRunningAgents: vi.fn(),
  getHookEnabled: vi.fn(() => false),
  getTaskExternalRefs: vi.fn(() => []),
  getTask: vi.fn(),
  inTransaction: vi.fn((fn: () => unknown) => fn()),
}));

// ─── launch.js ────────────────────────────────────────────────────────────────

const mockRunSetup = vi.fn(async () => {
  mockRunSetupCalls();
  return {
    worktreePath: '/tmp/wt',
    branch: 'agents/x',
    baseBranch: 'main',
    baseSha: 'sha',
    installHooksAt: '/tmp/wt',
  };
});
vi.mock('../launch.js', () => ({
  buildAgentStartupCommand: vi.fn(() => 'startup-cmd'),
  launchAgentWindow: vi.fn(async () => 0),
  computeFreshSessionIds: vi.fn(() => ({ sessionIdForDb: 'sid', sessionIdForLaunch: 'sid' })),
  applyOrchestratorMcpConfig: vi.fn((flags: unknown) => flags),
  prepareResumeLaunch: vi.fn(() => 'resume-cmd'),
}));
vi.mock('../setup/index.js', () => ({ runSetup: mockRunSetup }));

// ─── resume-task specific deps ───────────────────────────────────────────────

vi.mock('../../agent-session/substrate-tmux-windowed.js', () => ({
  tmuxWindowSubstrate: { createEmptySession: vi.fn(async () => undefined) },
}));
// SHR-261 landed after this file was written: start-task.ts now resolves a
// compute session before launching. Stub it so the policy assertions below
// reach buildLaunchCommand instead of dying on a real provider lookup.
vi.mock('../../compute/index.js', () => ({
  sessionFor: vi.fn(async () => ({
    kind: 'local',
    taskId: 't',
    repoPath: '/repo',
    exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    tmux: vi.fn(async () => ({ stdout: '', stderr: '' })),
    files: { read: vi.fn(), write: vi.fn(), mkdir: vi.fn(), exists: vi.fn(async () => true) },
    dispose: vi.fn(async () => undefined),
  })),
}));
vi.mock('../../tmux-bin.js', () => ({ execTmux: vi.fn(async () => ({ stdout: '', stderr: '' })) }));
vi.mock('../sessions.js', () => ({ cleanupLinkedSessions: vi.fn(async () => undefined) }));
vi.mock('../git.js', () => ({ checkDirty: vi.fn(async () => []) }));

// ─── publish-review specific deps ────────────────────────────────────────────

vi.mock('../../github-client.js', () => ({
  postPullRequestReview: vi.fn(async () => ({ id: 1, html_url: 'https://x/pr' })),
}));
vi.mock('../../inline-comments-outdated.js', () => ({
  isAnchorOutdated: vi.fn(async () => false),
}));
vi.mock('../../repositories/inline-comments.js', () => ({
  listComments: vi.fn(() => []),
  markCommentsStaleByIds: vi.fn(),
  markCommentsPublishedByIds: vi.fn(),
}));
vi.mock('../../repositories/published-reviews.js', () => ({ recordPublishedReview: vi.fn() }));
vi.mock('../../plugins/facts.js', () => ({ putCoreFact: vi.fn(async () => undefined) }));

// ─── hook-dispatcher specific deps ───────────────────────────────────────────

const mockListIntegrations = vi.fn<() => Integration[]>();
const mockGetProvider = vi.fn<(kind: string) => IntegrationProvider | undefined>();
vi.mock('../../integrations/store.js', () => ({ listIntegrations: mockListIntegrations }));
vi.mock('../../integrations/registry.js', () => ({ getProvider: mockGetProvider }));

// ─── modules under test ──────────────────────────────────────────────────────

const { startTask } = await import('./start-task.js');
const { resumeTask } = await import('./resume-task.js');
const { publishReview } = await import('../../workflows/reviewer/publish-review.js');
const { fireHook } = await import('../../hook-dispatcher.js');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 't',
    description: '',
    repo_path: '/tmp/test-repo',
    runtime_state: 'idle',
    workflow_status: 'backlog',
    run_mode: 'new',
    branch: null,
    base_branch: null,
    worktree: null,
    worktree_id: null,
    tmux_session: null,
    base_sha: null,
    pr_url: null,
    pr_number: null,
    pr_head_sha: null,
    user_window_index: null,
    initial_prompt: null,
    last_viewed_at: null,
    deleted_at: null,
    source: null,
    harness_id: 'claude-code',
    agent: null,
    model: null,
    notify_task_id: null,
    depends_on: null,
    error: null,
    current_summary: null,
    current_summary_updated_at: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  } as Task;
}

function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: 'int-1',
    kind: 'jira',
    name: 'Jira',
    config: {},
    enabled: true,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  } as Integration;
}

function makeProvider(overrides: Partial<IntegrationProvider> = {}): IntegrationProvider {
  return {
    kind: 'jira',
    displayName: 'Jira',
    configSchema: {},
    events: ['workflow_status_changed'],
    validate: vi.fn(() => ({ ok: true })),
    handler: vi.fn(async () => {}),
    ...overrides,
  } as unknown as IntegrationProvider;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('task.launch — start-task.ts', () => {
  it('deny surfaces via setRuntimeState(error) without touching setup', async () => {
    mockEnforcePolicy.mockRejectedValueOnce(
      new Error('policy denied task.launch: plugin "guard" — nope'),
    );

    await startTask(makeTask({ id: 'launch-deny' }));

    expect(mockSetRuntimeState).toHaveBeenCalledWith(
      'launch-deny',
      'error',
      expect.stringContaining('guard'),
    );
    expect(mockRunSetupCalls).not.toHaveBeenCalled();
  });

  it('patched model reaches buildLaunchCommand', async () => {
    mockEnforcePolicy.mockResolvedValueOnce({
      harnessId: 'claude-code',
      model: 'patched-model',
      agent: null,
    });

    await startTask(makeTask({ id: 'launch-patch', model: null }));

    expect(mockBuildLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'patched-model' }),
    );
    expect(mockSetRuntimeState).not.toHaveBeenCalledWith(
      'launch-patch',
      'error',
      expect.anything(),
    );
  });
});

describe('harness.resume — resume-task.ts', () => {
  it('deny surfaces via setRuntimeState(error) before touching resume plumbing', async () => {
    mockEnforcePolicy.mockRejectedValueOnce(
      new Error('policy denied harness.resume: plugin "guard2" — reason2'),
    );

    const task = makeTask({
      id: 'resume-deny',
      runtime_state: 'idle',
      worktree: '/tmp/test-repo/.worktrees/resume-deny',
      tmux_session: 'octomux-agent-resume-deny',
    });

    await resumeTask(task);

    expect(mockSetRuntimeState).toHaveBeenCalledWith(
      'resume-deny',
      'error',
      expect.stringContaining('guard2'),
    );
  });
});

describe('review.publish — publish-review.ts', () => {
  it('deny rejects with a policy denied message', async () => {
    mockEnforcePolicy.mockRejectedValueOnce(
      new Error('policy denied review.publish: plugin "guard3" — reason3'),
    );

    await expect(publishReview('task-1', 'COMMENT', 'body')).rejects.toThrow(/policy denied/);
  });
});

describe('integration.send — hook-dispatcher.ts', () => {
  it('denied provider is skipped; a sibling enabled provider still runs', async () => {
    const deniedProvider = makeProvider({ kind: 'jira' });
    const allowedProvider = makeProvider({ kind: 'linear' });

    mockListIntegrations.mockReturnValue([
      makeIntegration({ id: 'int-jira', kind: 'jira' }),
      makeIntegration({ id: 'int-linear', kind: 'linear' }),
    ]);
    mockGetProvider.mockImplementation((kind: string) =>
      kind === 'jira' ? deniedProvider : allowedProvider,
    );
    mockEvaluatePolicy.mockImplementation(
      async (_point: string, intent: { data: Record<string, unknown> }): Promise<PolicyOutcome> => {
        if (intent.data.integrationKind === 'jira') {
          return { allowed: false, reason: 'blocked', pluginId: 'guard4' };
        }
        return { allowed: true, data: intent.data };
      },
    );

    const envelope: HookEnvelope = {
      event: 'workflow_status_changed',
      task: { id: 'task-1' },
      data: { from: 'in_progress', to: 'done' },
    };

    await fireHook('workflow_status_changed', envelope);

    expect(deniedProvider.handler).not.toHaveBeenCalled();
    expect(allowedProvider.handler).toHaveBeenCalledOnce();
  });
});
