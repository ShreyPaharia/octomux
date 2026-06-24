import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../test-helpers';
import { TaskHooksPanel } from './TaskHooksPanel';
import type { HookExecution } from '@/lib/api/taskApi';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
}));

function makeExecution(overrides: Partial<HookExecution> = {}): HookExecution {
  return {
    event: 'workflow_status_changed',
    script: 'notify.sh',
    started_at: new Date(1700000000000).toISOString(),
    duration_ms: 250,
    exit_code: 0,
    log_path: '/logs/hooks/notify.log',
    stdout_excerpt: 'hook output here',
    stderr_excerpt: '',
    ...overrides,
  };
}

describe('TaskHooksPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getTaskHookExecutions.mockResolvedValue([]);
  });

  it('shows "No hook runs recorded" when empty', async () => {
    renderWithRouter(<TaskHooksPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByText('No hook runs recorded.')).toBeInTheDocument();
    });
  });

  it('calls getTaskHookExecutions with the task id', async () => {
    renderWithRouter(<TaskHooksPanel taskId="my-task" />);
    await waitFor(() => {
      expect(apiMock.getTaskHookExecutions).toHaveBeenCalledWith('my-task');
    });
  });

  it('renders hook execution rows', async () => {
    apiMock.getTaskHookExecutions.mockResolvedValue([
      makeExecution({ event: 'workflow_status_changed', script: 'notify.sh' }),
    ]);
    renderWithRouter(<TaskHooksPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('hook-execution-row')).toBeInTheDocument();
      expect(screen.getByText('workflow_status_changed')).toBeInTheDocument();
      expect(screen.getByText('notify.sh')).toBeInTheDocument();
    });
  });

  it('shows green badge for exit_code=0', async () => {
    apiMock.getTaskHookExecutions.mockResolvedValue([makeExecution({ exit_code: 0 })]);
    renderWithRouter(<TaskHooksPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('hook-exit-badge-ok')).toBeInTheDocument();
    });
  });

  it('shows red badge for non-zero exit_code', async () => {
    apiMock.getTaskHookExecutions.mockResolvedValue([makeExecution({ exit_code: 1 })]);
    renderWithRouter(<TaskHooksPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('hook-exit-badge-fail')).toBeInTheDocument();
    });
  });

  it('shows grey badge for null exit_code', async () => {
    apiMock.getTaskHookExecutions.mockResolvedValue([makeExecution({ exit_code: null })]);
    renderWithRouter(<TaskHooksPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('hook-exit-badge-unknown')).toBeInTheDocument();
    });
  });

  it('expands row to show stdout_excerpt on click', async () => {
    const user = userEvent.setup();
    apiMock.getTaskHookExecutions.mockResolvedValue([
      makeExecution({ stdout_excerpt: 'hook output data' }),
    ]);
    renderWithRouter(<TaskHooksPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('hook-execution-row')).toBeInTheDocument();
    });

    // Excerpt not visible initially
    expect(screen.queryByText('hook output data')).not.toBeInTheDocument();

    // Click the row toggle button (use aria-expanded approach)
    const expandButton = screen.getByRole('button', { expanded: false });
    await user.click(expandButton);

    await waitFor(() => {
      expect(screen.getByText('hook output data')).toBeInTheDocument();
    });
  });

  it('shows duration when available', async () => {
    apiMock.getTaskHookExecutions.mockResolvedValue([makeExecution({ duration_ms: 412 })]);
    renderWithRouter(<TaskHooksPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByText('412ms')).toBeInTheDocument();
    });
  });

  it('refetches when refresh button clicked', async () => {
    renderWithRouter(<TaskHooksPanel taskId="task-1" />);
    await waitFor(() => {
      expect(apiMock.getTaskHookExecutions).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('hooks-refresh-button'));
    await waitFor(() => {
      expect(apiMock.getTaskHookExecutions).toHaveBeenCalledTimes(2);
    });
  });
});
