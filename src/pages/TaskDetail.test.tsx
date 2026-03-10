import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskDetail from './TaskDetail';
import { renderWithRouter, makeTask, mockApi } from '../test-helpers';
import type { Task } from '../../server/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const apiMock = mockApi();

vi.mock('@/lib/api', () => ({
  api: new Proxy(
    {},
    {
      get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock],
    },
  ),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// Mock TerminalView — it needs xterm.js which isn't available in jsdom
vi.mock('@/components/TerminalView', () => ({
  TerminalView: ({ taskId, windowIndex }: { taskId: string; windowIndex: number }) => (
    <div data-testid="terminal-view" data-task-id={taskId} data-window-index={windowIndex} />
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const runningTask: Task = makeTask({
  status: 'running',
  tmux_session: 'octomux-agent-test-task-01',
  agents: [
    {
      id: 'a1',
      task_id: 'test-task-01',
      window_index: 0,
      label: 'Agent 1',
      status: 'running',
      created_at: '2026-01-01 00:00:00',
    },
  ],
});

describe('TaskDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('shows back to dashboard button on error', async () => {
    apiMock.getTask.mockRejectedValue(new Error('fail'));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Back to Dashboard')).toBeInTheDocument();
    });
  });

  // ─── Header content (table-driven) ────────────────────────────────────────

  const headerElements = [
    { name: 'title', text: 'Fix order validation' },
    { name: 'description', text: 'Add negative quantity checks' },
    { name: 'back button', text: 'Back' },
  ];

  it.each(headerElements)('shows $name in header', async ({ text }) => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText(text)).toBeInTheDocument();
    });
  });

  // ─── Running task controls ────────────────────────────────────────────────

  it('shows Close button for running task', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Close')).toBeInTheDocument();
    });
  });

  it('clicking Close calls updateTask with status "closed"', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Close')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Close'));
    await waitFor(() => {
      expect(apiMock.updateTask).toHaveBeenCalledWith('test-task-01', { status: 'closed' });
    });
  });

  // ─── Draft task controls ────────────────────────────────────────────────

  it('shows Start button for draft task', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ status: 'draft', agents: [] }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Start')).toBeInTheDocument();
    });
  });

  it('clicking Start calls startTask', async () => {
    const user = userEvent.setup();
    apiMock.getTask.mockResolvedValue(makeTask({ status: 'draft', agents: [] }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Start')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Start'));
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
    expect(screen.queryByText('Close')).not.toBeInTheDocument();
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

  it('shows "Setting up" message when task is draft', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ status: 'draft', agents: [] }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Setting up terminal...')).toBeInTheDocument();
    });
  });

  it('shows "No terminal" message for closed task without agents', async () => {
    apiMock.getTask.mockResolvedValue(
      makeTask({ status: 'closed', tmux_session: null, agents: [] }),
    );
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('No terminal available')).toBeInTheDocument();
    });
  });

  // ─── Agent tabs ───────────────────────────────────────────────────────────

  it('renders agent tabs for running task', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeInTheDocument();
    });
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
      const link = screen.getByText('PR #42');
      expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/42');
    });
  });

  // ─── Error display ────────────────────────────────────────────────────────

  it('shows task error when present', async () => {
    apiMock.getTask.mockResolvedValue(makeTask({ status: 'error', error: 'Setup failed' }));
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Setup failed')).toBeInTheDocument();
    });
  });

  // ─── Navigation ───────────────────────────────────────────────────────────

  it('navigates back to dashboard on back button click', async () => {
    const user = userEvent.setup();
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText('Back')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Back'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
