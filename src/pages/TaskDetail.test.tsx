import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskDetail, { _resetPerTaskUiState } from './TaskDetail';
import { renderWithRouter, makeTask, makeAgent } from '../test-helpers';
import type { Task } from '@octomux/types';

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

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api/taskApi', async () => {
  const actual = (await vi.importActual('@/lib/api/taskApi')) as Record<string, unknown>;
  return { ...actual, taskApi: taskApiProxy };
});
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

const { routerMockFactory, mockNavigate } = await vi.hoisted(async () =>
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
  runtime_state: 'running',
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

  // ─── auto_review redirect ─────────────────────────────────────────────────

  it('redirects to /reviews/:id when task source is auto_review', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ id: 'test-task-01', source: 'auto_review' }));
    renderDetail();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/reviews/test-task-01', { replace: true });
    });
  });

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

  // ─── Running task controls ────────────────────────────────────────────────

  it('shows Done button for running task', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
  });

  it('clicking Done opens an inline confirm sheet (no native dialog)', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Done'));
    expect(await screen.findByTestId('close-confirm')).toBeInTheDocument();
    // Not called until confirmed
    expect(apiMock.moveTask).not.toHaveBeenCalled();
  });

  it('confirming the Done sheet calls moveTask with workflow_status "done"', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Done'));
    await user.click(await screen.findByTestId('close-confirm-accept'));
    await waitFor(() => {
      expect(apiMock.moveTask).toHaveBeenCalledWith('test-task-01', {
        workflow_status: 'done',
      });
    });
  });

  it('cancel in Done confirm sheet dismisses without calling moveTask', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Done'));
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('close-confirm')).not.toBeInTheDocument();
    });
    expect(apiMock.moveTask).not.toHaveBeenCalled();
  });

  // ─── Draft task controls ────────────────────────────────────────────────

  it('shows Start button for draft task', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: 'idle', agents: [] }));
    renderDetail();
    await waitFor(() => {
      // Header has a Start button, edit form also has one
      const startButtons = screen.getAllByText('Start');
      expect(startButtons.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('clicking Start calls startTask', async () => {
    const user = userEvent.setup();
    apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: 'idle', agents: [] }));
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

  const nonRunningStates = ['idle', 'error'] as const;

  it.each(nonRunningStates)('hides Close button when runtime_state is "%s"', async (state) => {
    apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: state, agents: [] }));
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
    apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: 'idle', agents: [] }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByLabelText('Title')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
    });
  });

  it('shows "Terminal session ended" message for closed task without agents', async () => {
    apiMock.getTask.mockResolvedValue(
      // initial_prompt set → not a draft, just a closed task with no active terminal
      makeTask({ runtime_state: 'idle', tmux_session: null, agents: [], initial_prompt: 'do it' }),
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

  // ─── Review button ────────────────────────────────────────────────────────

  it('renders a Review button labelled "Review" for a running task without an existing review', async () => {
    renderDetail();
    const button = await screen.findByTestId('review-button');
    expect(button).toHaveTextContent('Review');
    expect(button).not.toBeDisabled();
  });

  it('clicking Review triggers POST and navigates to the new review', async () => {
    const user = userEvent.setup();
    apiMock.triggerManualReview.mockResolvedValue({ id: 'rev-new', action: 'created' });
    renderDetail();
    const button = await screen.findByTestId('review-button');
    await user.click(button);
    await waitFor(() => {
      expect(apiMock.triggerManualReview).toHaveBeenCalledWith('test-task-01');
    });
    expect(mockNavigate).toHaveBeenCalledWith('/reviews/rev-new');
  });

  it('flips label to "Open review" and navigates without POSTing when an existing review exists', async () => {
    const user = userEvent.setup();
    apiMock.getTask.mockResolvedValue(
      makeTask({
        ...runningTask,
        existing_review_id: 'rev-existing',
      }),
    );
    renderDetail();
    const button = await screen.findByTestId('review-button');
    expect(button).toHaveTextContent('Open review');
    await user.click(button);
    expect(apiMock.triggerManualReview).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/reviews/rev-existing');
  });

  it('disables the Review button when source task is a draft (no branch yet)', async () => {
    apiMock.getTask.mockResolvedValue(
      makeTask({
        runtime_state: 'idle',
        branch: null,
        worktree: null,
        agents: [],
      }),
    );
    renderDetail();
    const button = await screen.findByTestId('review-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Start the task first');
  });

  it('hides the Review button for an error-state task', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: 'error', error: 'boom' }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('review-button')).not.toBeInTheDocument();
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
    apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: 'error', error: 'Setup failed' }));
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
      makeTask({ runtime_state: 'setting_up', agents: [], tmux_session: null }),
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

    const noEditorStates = ['idle', 'setting_up', 'error'] as const;

    it.each(noEditorStates)('hides Editor button when runtime_state is "%s"', async (state) => {
      apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: state, agents: [] }));
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

      apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: 'setting_up', agents: [] }));
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

      apiMock.getTask.mockResolvedValue(makeTask({ runtime_state: 'setting_up', agents: [] }));
      simulateEvent();
      await waitFor(() => {
        expect(screen.getByTestId('task-setting-up')).toBeInTheDocument();
      });
    });
  });

  // ─── User terminals ────────────────────────────────────────────────────────

  describe('User terminals', () => {
    const taskWithTerminals = makeTask({
      runtime_state: 'running',
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
            runtime_state: 'running',
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

        const repoLabel = screen.queryByText('Repo');
        if (showsBranchInfo) expect(repoLabel).toBeInTheDocument();
        else expect(repoLabel).not.toBeInTheDocument();
      },
    );

    it('none mode renders branch with "(working tree)" suffix', async () => {
      apiMock.getTask.mockResolvedValue(
        makeTask({
          run_mode: 'none',
          runtime_state: 'running',
          branch: 'feat/inplace',
          agents: [makeAgent({ id: 'a1' })],
        }),
      );
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('feat/inplace (working tree)')).toBeInTheDocument();
      });
    });

    it('existing mode uses "Worktree head" label', async () => {
      apiMock.getTask.mockResolvedValue(
        makeTask({
          run_mode: 'existing',
          runtime_state: 'running',
          branch: 'feat/existing',
          agents: [makeAgent({ id: 'a1' })],
        }),
      );
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Worktree head')).toBeInTheDocument();
      });
    });

    it('scratch mode hides PR link even when pr_url is set', async () => {
      apiMock.getTask.mockResolvedValue(
        makeTask({
          run_mode: 'scratch',
          runtime_state: 'running',
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
          runtime_state: 'running',
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
          runtime_state: 'running',
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

  // ─── Review cockpit integration ───────────────────────────────────────────

  describe('review cockpit integration', () => {
    function makeDiffSummary(overrides: Record<string, unknown> = {}) {
      return {
        files: [
          {
            path: 'src/foo.ts',
            status: 'M',
            additions: 1,
            deletions: 0,
            reviewed: false,
            ignored: false,
          },
        ],
        ignoredTruncated: false,
        base_sha: 'abc123',
        base_ref: 'main',
        base_is_stale: false,
        reviewed_count: 0,
        total_count: 1,
        ...overrides,
      };
    }

    async function openDiff(user: ReturnType<typeof userEvent.setup>) {
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^diff$/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /^diff$/i }));
    }

    it('toggling a file checkbox calls taskApi.markReviewed and refetches', async () => {
      const user = userEvent.setup();
      apiMock.getTask.mockResolvedValue(
        makeTask({
          runtime_state: 'running',
          worktree: '/tmp/wt',
          base_branch: 'main',
          agents: [makeAgent({ id: 'a1' })],
        }),
      );
      apiMock.getTaskDiffSummary.mockResolvedValue(makeDiffSummary());
      apiMock.markReviewed.mockResolvedValue(undefined);

      renderDetail();
      await openDiff(user);

      const checkbox = await screen.findByTestId('review-toggle-src/foo.ts');
      await user.click(checkbox);

      await waitFor(() => {
        expect(apiMock.markReviewed).toHaveBeenCalledWith('test-task-01', 'src/foo.ts');
      });
    });

    it('queueing comments and pressing Cmd+Enter sends a batched message to the active agent', async () => {
      const user = userEvent.setup();
      apiMock.getTask.mockResolvedValue(
        makeTask({
          runtime_state: 'running',
          worktree: '/tmp/wt',
          base_branch: 'main',
          agents: [makeAgent({ id: 'agent-99', window_index: 0, status: 'running' })],
        }),
      );
      apiMock.getTaskDiffSummary.mockResolvedValue(makeDiffSummary());
      apiMock.sendAgentMessage.mockResolvedValue({ ok: true });

      // Seed two queued comments BEFORE render so useReviewQueue picks them
      // up via its lazy-init load() — we don't depend on DiffViewer's inline
      // composer being visible in the API-driven mode.
      const queueKey = 'octomux:review-queue:test-task-01';
      const seed = [
        {
          id: 'c1',
          filePath: 'src/foo.ts',
          line: 1,
          lineText: 'foo',
          body: 'first',
        },
        {
          id: 'c2',
          filePath: 'src/foo.ts',
          line: 2,
          lineText: 'bar',
          body: 'second',
        },
      ];
      localStorage.setItem(queueKey, JSON.stringify(seed));

      renderDetail();
      await openDiff(user);

      // Drawer renders only when comments > 0 — verify it's there.
      await waitFor(() => {
        expect(screen.getByText(/Queued review/i)).toBeInTheDocument();
      });

      // Fire global Cmd+Enter — useDiffKeyboardNav listens on window.
      await user.keyboard('{Meta>}{Enter}{/Meta}');

      await waitFor(() => {
        expect(apiMock.sendAgentMessage).toHaveBeenCalledTimes(1);
      });
      const [tid, aid, body] = apiMock.sendAgentMessage.mock.calls[0];
      expect(tid).toBe('test-task-01');
      expect(aid).toBe('agent-99');
      expect(body).toContain('src/foo.ts:1');
      expect(body).toContain('first');
      expect(body).toContain('src/foo.ts:2');
      expect(body).toContain('second');

      localStorage.removeItem(queueKey);
    });

    it('shows offline indicator when base_is_stale is true on the diff response', async () => {
      const user = userEvent.setup();
      apiMock.getTask.mockResolvedValue(
        makeTask({
          runtime_state: 'running',
          worktree: '/tmp/wt',
          base_branch: 'main',
          agents: [makeAgent({ id: 'a1' })],
        }),
      );
      apiMock.getTaskDiffSummary.mockResolvedValue(makeDiffSummary({ base_is_stale: true }));

      renderDetail();
      await openDiff(user);

      await waitFor(() => {
        expect(screen.getByText(/local base \(offline\)/i)).toBeInTheDocument();
      });
    });

    it('renders the keybind cheat-sheet trigger in diff mode', async () => {
      const user = userEvent.setup();
      apiMock.getTask.mockResolvedValue(
        makeTask({
          runtime_state: 'running',
          worktree: '/tmp/wt',
          base_branch: 'main',
          agents: [makeAgent({ id: 'a1' })],
        }),
      );
      apiMock.getTaskDiffSummary.mockResolvedValue(makeDiffSummary());

      renderDetail();
      await openDiff(user);

      expect(await screen.findByTestId('diff-keybind-help')).toBeInTheDocument();
    });
  });
});
