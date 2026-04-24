import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskDetail, { _resetPerTaskUiState } from './TaskDetail';
import { renderWithRouter, makeTask, makeAgent } from '../test-helpers';
import type { Task } from '../../server/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

let eventCallbacks: Set<(event: any) => void>;
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn((cb: (event: any) => void) => {
    eventCallbacks.add(cb);
    return () => eventCallbacks.delete(cb);
  }),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

function simulateEvent(taskId = 'test-task-01') {
  const event = { type: 'task:updated', payload: { taskId } };
  for (const cb of eventCallbacks) cb(event);
}

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api', () => ({ api: apiProxy }));

const { routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

// Mock TerminalView — it needs xterm.js which isn't available in jsdom
vi.mock('@/components/TerminalView', () => ({
  TerminalView: ({
    taskId,
    windowIndex,
    visible,
  }: {
    taskId: string;
    windowIndex: number;
    visible?: boolean;
  }) => (
    <div
      data-testid="terminal-view"
      data-task-id={taskId}
      data-window-index={windowIndex}
      data-visible={String(visible ?? true)}
    />
  ),
}));

// Monaco relies on browser APIs not available in jsdom — stub it.
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: () => <div data-testid="monaco-diff" />,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const runningTask: Task = makeTask({
  status: 'running',
  tmux_session: 'octomux-agent-test-task-01',
  agents: [makeAgent({ id: 'a1' })],
});

describe('TaskDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPerTaskUiState();
    eventCallbacks = new Set();
    apiMock.getTask.mockResolvedValue(runningTask);
    apiMock.updateTask.mockResolvedValue(runningTask);
    apiMock.startTask.mockResolvedValue(runningTask);
    apiMock.addAgent.mockResolvedValue({
      id: 'a2',
      task_id: 'test-task-01',
      window_index: 1,
      label: 'Agent 2',
      status: 'running',
      created_at: '',
    });
    apiMock.stopAgent.mockResolvedValue(undefined);
  });

  function renderDetail() {
    return renderWithRouter(<TaskDetail />, {
      route: '/tasks/test-task-01',
      path: '/tasks/:id',
    });
  }

  // ─── Loading state ────────────────────────────────────────────────────────

  it('shows loading state initially', () => {
    apiMock.getTask.mockReturnValue(new Promise(() => {}));
    renderDetail();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  // ─── Error state ──────────────────────────────────────────────────────────

  it('shows error when task fetch fails', async () => {
    apiMock.getTask.mockRejectedValue(new Error('Not found'));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Not found')).toBeInTheDocument();
    });
  });

  it('shows back to tasks button on error', async () => {
    apiMock.getTask.mockRejectedValue(new Error('fail'));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Back to Tasks')).toBeInTheDocument();
    });
  });

  // ─── Header content ───────────────────────────────────────────────────────

  it('shows title in header', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });
  });

  it('does not render the description subtitle in the header (glass compact header)', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });
    expect(screen.queryByText('Add negative quantity checks')).not.toBeInTheDocument();
  });

  it('renders the ⌘K keycap in the header action cluster for running tasks', async () => {
    renderDetail();
    const header = await screen.findByTestId('task-detail-header');
    expect(header.textContent).toContain('⌘');
  });

  // ─── Running task controls ────────────────────────────────────────────────

  it('shows Close button for running task', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('CLOSE')).toBeInTheDocument();
    });
  });

  it('clicking Close opens an inline confirm sheet (no native dialog)', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('CLOSE')).toBeInTheDocument();
    });
    await user.click(screen.getByText('CLOSE'));
    expect(await screen.findByTestId('close-confirm')).toBeInTheDocument();
    // Not called until confirmed
    expect(apiMock.updateTask).not.toHaveBeenCalled();
  });

  it('confirming the Close sheet calls updateTask with status "closed"', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('CLOSE')).toBeInTheDocument();
    });
    await user.click(screen.getByText('CLOSE'));
    await user.click(await screen.findByTestId('close-confirm-accept'));
    await waitFor(() => {
      expect(apiMock.updateTask).toHaveBeenCalledWith('test-task-01', { status: 'closed' });
    });
  });

  it('cancel in Close confirm sheet dismisses without calling updateTask', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('CLOSE')).toBeInTheDocument();
    });
    await user.click(screen.getByText('CLOSE'));
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('close-confirm')).not.toBeInTheDocument();
    });
    expect(apiMock.updateTask).not.toHaveBeenCalled();
  });

  // ─── Draft task controls ────────────────────────────────────────────────

  it('shows Start button for draft task', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ status: 'draft', agents: [] }));
    renderDetail();
    await waitFor(() => {
      // Header has a Start button, edit form also has one
      const startButtons = screen.getAllByText('Start');
      expect(startButtons.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('clicking Start calls startTask', async () => {
    const user = userEvent.setup();
    apiMock.getTask.mockResolvedValue(makeTask({ status: 'draft', agents: [] }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getAllByText('Start').length).toBeGreaterThanOrEqual(1);
    });
    // Click the header Start button (first one)
    await user.click(screen.getAllByText('Start')[0]);
    await waitFor(() => {
      expect(apiMock.startTask).toHaveBeenCalledWith('test-task-01');
    });
  });

  // ─── Non-running task hides Close button ──────────────────────────────────

  const nonRunningStatuses = ['closed', 'error', 'draft'] as const;

  it.each(nonRunningStatuses)('hides Close button when status is "%s"', async (status) => {
    apiMock.getTask.mockResolvedValue(makeTask({ status, agents: [] }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });
    expect(screen.queryByText('CLOSE')).not.toBeInTheDocument();
  });

  // ─── Terminal rendering ───────────────────────────────────────────────────

  it('renders terminal view for running task with agents', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
    });
  });

  it('passes correct taskId and windowIndex to terminal', async () => {
    renderDetail();
    await waitFor(() => {
      const terminal = screen.getByTestId('terminal-view');
      expect(terminal).toHaveAttribute('data-task-id', 'test-task-01');
      expect(terminal).toHaveAttribute('data-window-index', '0');
    });
  });

  it('shows edit form when task is draft', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ status: 'draft', agents: [] }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByLabelText('Title')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
    });
  });

  it('shows "Terminal session ended" message for closed task without agents', async () => {
    apiMock.getTask.mockResolvedValue(
      makeTask({ status: 'closed', tmux_session: null, agents: [] }),
    );
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Terminal session ended')).toBeInTheDocument();
    });
  });

  // ─── Agent tabs ───────────────────────────────────────────────────────────

  it('renders agent tabs for running task', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeInTheDocument();
    });
  });

  it('active agent tab renders a state chip glyph (T1 StatusGlyph)', async () => {
    renderDetail();
    const tab = await screen.findByTestId('agent-tab-a1');
    expect(tab).toHaveAttribute('data-active', 'true');
    expect(tab).toHaveAttribute('data-display-status', 'running');
    // StatusGlyph renders role=img with an aria-label for the state name
    expect(tab.querySelector('[role="img"][aria-label="running"]')).not.toBeNull();
  });

  // ─── Ship button ──────────────────────────────────────────────────────────

  it('shows the Ship button for a running task and dispatches open-pr-sheet on click', async () => {
    const user = userEvent.setup();
    renderDetail();
    const ship = await screen.findByTestId('ship-button');
    const spy = vi.fn();
    window.addEventListener('octomux:open-pr-sheet', spy);
    try {
      await user.click(ship);
      expect(spy).toHaveBeenCalled();
      const evt = spy.mock.calls[0][0] as CustomEvent<{ taskId: string }>;
      expect(evt.detail.taskId).toBe('test-task-01');
    } finally {
      window.removeEventListener('octomux:open-pr-sheet', spy);
    }
  });

  it('hides the Ship button for a scratch task (no repo)', async () => {
    apiMock.getTask.mockResolvedValue(
      makeTask({ run_mode: 'scratch', status: 'running', agents: [makeAgent({ id: 'a1' })] }),
    );
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('ship-button')).not.toBeInTheDocument();
  });

  // ─── PR link ──────────────────────────────────────────────────────────────

  it('shows PR link when available', async () => {
    apiMock.getTask.mockResolvedValue(
      makeTask({
        ...runningTask,
        pr_url: 'https://github.com/org/repo/pull/42',
        pr_number: 42,
      }),
    );
    renderDetail();
    await waitFor(() => {
      const link = screen.getByText('#42');
      expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/42');
    });
  });

  // ─── Error display ────────────────────────────────────────────────────────

  it('shows task error when present', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ status: 'error', error: 'Setup failed' }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId('task-error-view')).toBeInTheDocument();
    });
    const banner = screen.getByTestId('task-error-banner');
    expect(banner).toHaveTextContent('Setup failed');
    expect(screen.getByTestId('task-error-retry')).toBeInTheDocument();
    expect(screen.getByTestId('task-error-delete')).toBeInTheDocument();
  });

  it('renders setting_up checklist when status=setting_up and no terminal yet', async () => {
    apiMock.getTask.mockResolvedValue(
      makeTask({ status: 'setting_up', agents: [], tmux_session: null }),
    );
    renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId('task-setting-up')).toBeInTheDocument();
    });
    expect(screen.getByText(/setting up task/i)).toBeInTheDocument();
    expect(screen.getByText(/Launching Claude Code/i)).toBeInTheDocument();
  });

  // ─── Editor toggle ───────────────────────────────────────────────────────

  describe('editor toggle', () => {
    it('shows Editor button for running task with tmux session', async () => {
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });
    });

    const noEditorStatuses = ['draft', 'setting_up', 'closed', 'error'] as const;

    it.each(noEditorStatuses)('hides Editor button when status is "%s"', async (status) => {
      apiMock.getTask.mockResolvedValue(makeTask({ status, agents: [] }));
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Fix order validation')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /editor/i })).not.toBeInTheDocument();
    });

    it('toggles to editor mode on click', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /editor/i }));

      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalledWith('test-task-01');
      });
    });

    it('switches back to agents mode on second click', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalled();
      });

      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(screen.getByText('Agent 1')).toBeInTheDocument();
      });
    });

    it('resets userWindowIndex when task leaves running state so next toggle re-creates', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalledTimes(1);
      });

      apiMock.getTask.mockResolvedValue(makeTask({ status: 'setting_up', agents: [] }));
      simulateEvent();
      await waitFor(() => {
        expect(screen.getByTestId('task-setting-up')).toBeInTheDocument();
      });

      apiMock.getTask.mockResolvedValue(runningTask);
      simulateEvent();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalledTimes(2);
      });
    });

    it('unmounts editor terminal when switching back to agents mode (prevents stale PTY resize)', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      // Open editor — creates user terminal and mounts editor TerminalView
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalled();
      });

      // Editor terminal should be mounted with the user window index
      const editorTerminals = screen
        .getAllByTestId('terminal-view')
        .filter((el) => el.getAttribute('data-window-index') === '5');
      expect(editorTerminals).toHaveLength(1);

      // Switch back to agents
      await user.click(screen.getByRole('button', { name: /editor/i }));

      // Editor terminal (window index 5) should be fully unmounted, NOT just hidden.
      // If it were CSS-hidden, a ResizeObserver could fire a 0×0 resize to the PTY,
      // corrupting nvim's layout on reopen.
      await waitFor(() => {
        const remaining = screen
          .getAllByTestId('terminal-view')
          .filter((el) => el.getAttribute('data-window-index') === '5');
        expect(remaining).toHaveLength(0);
      });
    });

    it('mounts a fresh editor terminal each time editor is reopened', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      // Open editor
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalledTimes(1);
      });

      // Editor terminal mounted
      expect(
        screen
          .getAllByTestId('terminal-view')
          .some((el) => el.getAttribute('data-window-index') === '5'),
      ).toBe(true);

      // Close editor
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(
          screen
            .getAllByTestId('terminal-view')
            .every((el) => el.getAttribute('data-window-index') !== '5'),
        ).toBe(true);
      });

      // Reopen editor — should mount a new terminal (not reuse hidden one)
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        const editorTerminals = screen
          .getAllByTestId('terminal-view')
          .filter((el) => el.getAttribute('data-window-index') === '5');
        expect(editorTerminals).toHaveLength(1);
      });

      // Always calls API to check current editor setting
      expect(apiMock.createUserTerminal).toHaveBeenCalledTimes(2);
    });

    it('agent terminal stays mounted while editor is open', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
      });

      // Agent terminal should be present (window index 0)
      expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-window-index', '0');

      // Open editor
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalled();
      });

      // Both agent (window 0) and editor (window 5) terminals should exist
      const terminals = screen.getAllByTestId('terminal-view');
      const windowIndices = terminals.map((el) => el.getAttribute('data-window-index'));
      expect(windowIndices).toContain('0');
      expect(windowIndices).toContain('5');
    });

    it('auto-switches to agents when task enters setting_up state', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalled();
      });

      apiMock.getTask.mockResolvedValue(makeTask({ status: 'setting_up', agents: [] }));
      simulateEvent();
      await waitFor(() => {
        expect(screen.getByTestId('task-setting-up')).toBeInTheDocument();
      });
    });
  });

  // ─── User terminals ────────────────────────────────────────────────────────

  describe('User terminals', () => {
    const taskWithTerminals = makeTask({
      status: 'running',
      tmux_session: 'octomux-agent-test-task-01',
      agents: [makeAgent({ id: 'a1' })],
      user_terminals: [
        {
          id: 'term-1',
          task_id: 'test-task-01',
          window_index: 3,
          label: 'Terminal 1',
          status: 'idle' as const,
          created_at: '2026-01-01 00:00:00',
        },
      ],
    });

    it('renders terminal tabs from task data', async () => {
      apiMock.getTask.mockResolvedValue(taskWithTerminals);
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      });
    });

    it('creates terminal on add and switches to it', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByTitle('Add terminal')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Add terminal'));

      await waitFor(() => {
        expect(apiMock.createTerminal).toHaveBeenCalledWith('test-task-01');
      });
    });

    it('closes terminal on close click', async () => {
      const user = userEvent.setup();
      apiMock.getTask.mockResolvedValue(taskWithTerminals);
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Close terminal'));

      await waitFor(() => {
        expect(apiMock.closeTerminal).toHaveBeenCalledWith('test-task-01', 'term-1');
      });
    });
  });

  // ─── Run mode rendering ───────────────────────────────────────────────────

  describe('run mode', () => {
    const modeCases = [
      {
        mode: 'new' as const,
        badge: 'N',
        tooltip: 'new worktree',
        showsDiff: true,
        showsBranchInfo: true,
      },
      {
        mode: 'existing' as const,
        badge: 'E',
        tooltip: 'attached existing',
        showsDiff: true,
        showsBranchInfo: true,
      },
      {
        mode: 'none' as const,
        badge: 'Ø',
        tooltip: 'in-place (no worktree)',
        showsDiff: true,
        showsBranchInfo: true,
      },
      {
        mode: 'scratch' as const,
        badge: 'S',
        tooltip: 'scratch',
        showsDiff: false,
        showsBranchInfo: false,
      },
    ];

    it.each(modeCases)(
      '$mode mode: badge=$badge, showsDiff=$showsDiff, showsBranchInfo=$showsBranchInfo',
      async ({ mode, badge, tooltip, showsDiff, showsBranchInfo }) => {
        apiMock.getTask.mockResolvedValue(
          makeTask({
            run_mode: mode,
            status: 'running',
            agents: [makeAgent({ id: 'a1' })],
            branch: mode === 'scratch' ? null : 'agents/test-task-01',
            repo_path: mode === 'scratch' ? '' : '/Users/dev/projects/my-repo',
          }),
        );
        renderDetail();
        await waitFor(() => {
          const b = screen.getByTestId('mode-badge');
          expect(b).toHaveTextContent(badge);
          expect(b).toHaveAttribute('title', tooltip);
        });

        const diffBtn = screen.queryByRole('button', { name: /^diff$/i });
        if (showsDiff) expect(diffBtn).toBeInTheDocument();
        else expect(diffBtn).not.toBeInTheDocument();

        const repoLabel = screen.queryByText('REPO');
        if (showsBranchInfo) expect(repoLabel).toBeInTheDocument();
        else expect(repoLabel).not.toBeInTheDocument();
      },
    );

    it('none mode renders branch with "(working tree)" suffix', async () => {
      apiMock.getTask.mockResolvedValue(
        makeTask({
          run_mode: 'none',
          status: 'running',
          branch: 'feat/inplace',
          agents: [makeAgent({ id: 'a1' })],
        }),
      );
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('feat/inplace (working tree)')).toBeInTheDocument();
      });
    });

    it('existing mode uses "WORKTREE HEAD" label', async () => {
      apiMock.getTask.mockResolvedValue(
        makeTask({
          run_mode: 'existing',
          status: 'running',
          branch: 'feat/existing',
          agents: [makeAgent({ id: 'a1' })],
        }),
      );
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('WORKTREE HEAD')).toBeInTheDocument();
      });
    });

    it('scratch mode hides PR link even when pr_url is set', async () => {
      apiMock.getTask.mockResolvedValue(
        makeTask({
          run_mode: 'scratch',
          status: 'running',
          agents: [makeAgent({ id: 'a1' })],
          pr_url: 'https://github.com/org/repo/pull/99',
          pr_number: 99,
        }),
      );
      renderDetail();
      await waitFor(() => {
        expect(screen.getByTestId('mode-badge')).toHaveTextContent('S');
      });
      expect(screen.queryByText('#99')).not.toBeInTheDocument();
    });

    it('falls back to "new" badge when run_mode is undefined', async () => {
      apiMock.getTask.mockResolvedValue(
        makeTask({
          run_mode: undefined as unknown as 'new',
          status: 'running',
          agents: [makeAgent({ id: 'a1' })],
        }),
      );
      renderDetail();
      await waitFor(() => {
        expect(screen.getByTestId('mode-badge')).toHaveTextContent('N');
      });
    });
  });

  // ─── Diff toggle ──────────────────────────────────────────────────────────

  describe('diff toggle', () => {
    it('shows DIFF button and renders DiffViewer when clicked', async () => {
      const user = userEvent.setup();
      apiMock.getTask.mockResolvedValue(
        makeTask({
          status: 'running',
          worktree: '/tmp/wt',
          base_branch: 'main',
        }),
      );
      apiMock.getTaskDiffSummary.mockResolvedValue({ files: [] });
      renderWithRouter(<TaskDetail />, { route: '/tasks/test-task-01', path: '/tasks/:id' });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /diff/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /diff/i }));
      await waitFor(() => expect(screen.getByText(/no changes/i)).toBeInTheDocument());
    });
  });
});
