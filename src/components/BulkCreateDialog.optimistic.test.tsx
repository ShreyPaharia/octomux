/**
 * Optimistic task create tests for BulkCreateDialog.
 *
 * Verifies:
 * 1. addOptimistic is called with each created task immediately after POST returns.
 * 2. addOptimistic is NOT called when createTask fails (no partial optimistic injection).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BulkCreateDialog } from './BulkCreateDialog';
import { renderWithRouter, makeTask } from '../test-helpers';
import type { TasksState } from '../lib/tasks-context';

// ── Hoist API mocks ──────────────────────────────────────────────────────────
const { taskApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

// ── Mock TasksContext ────────────────────────────────────────────────────────
const mockAddOptimistic = vi.fn();
const mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/tasks-context', () => ({
  useTasksContext: (): TasksState => ({
    tasks: [],
    loading: false,
    error: null,
    refresh: mockRefresh,
    addOptimistic: mockAddOptimistic,
  }),
  useTasksContextOptional: () => null,
  TasksProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const REPO_PLACEHOLDER = '/Users/you/projects/my-repo';

function renderDialog() {
  return renderWithRouter(<BulkCreateDialog open onOpenChange={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listTasks.mockResolvedValue([]);
  apiMock.createTask.mockResolvedValue(makeTask({ id: 'real-task-1' }));
});

describe('BulkCreateDialog — optimistic updates', () => {
  it('calls addOptimistic with the server response after each successful createTask', async () => {
    const user = userEvent.setup();
    const createdTask = makeTask({ id: 'real-task-1', title: 'Task one' });
    apiMock.createTask.mockResolvedValueOnce(createdTask);

    renderDialog();

    const textarea = screen.getByTestId('bulk-paste-textarea');
    await user.click(textarea);
    await user.paste('Task one');
    await user.type(screen.getByPlaceholderText(REPO_PLACEHOLDER), '/dev/octomux');

    const submit = screen.getByTestId('bulk-create-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalledTimes(1));
    // addOptimistic should have been called with the exact server response
    await waitFor(() => expect(mockAddOptimistic).toHaveBeenCalledWith(createdTask));
  });

  it('calls addOptimistic once per successfully created task in a batch', async () => {
    const user = userEvent.setup();
    const task1 = makeTask({ id: 'task-1', title: 'Task one' });
    const task2 = makeTask({ id: 'task-2', title: 'Task two' });
    apiMock.createTask.mockResolvedValueOnce(task1).mockResolvedValueOnce(task2);

    renderDialog();

    const textarea = screen.getByTestId('bulk-paste-textarea');
    await user.click(textarea);
    await user.paste('Task one\nTask two');
    await user.type(screen.getByPlaceholderText(REPO_PLACEHOLDER), '/dev/octomux');

    const submit = screen.getByTestId('bulk-create-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockAddOptimistic).toHaveBeenCalledTimes(2));
    expect(mockAddOptimistic).toHaveBeenCalledWith(task1);
    expect(mockAddOptimistic).toHaveBeenCalledWith(task2);
  });

  it('does NOT call addOptimistic when createTask fails', async () => {
    const user = userEvent.setup();
    apiMock.createTask.mockRejectedValueOnce(new Error('Network error'));

    renderDialog();

    const textarea = screen.getByTestId('bulk-paste-textarea');
    await user.click(textarea);
    await user.paste('Failing task');
    await user.type(screen.getByPlaceholderText(REPO_PLACEHOLDER), '/dev/octomux');

    const submit = screen.getByTestId('bulk-create-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    // Summary shows 0 created, 1 failed
    const summary = await screen.findByTestId('bulk-summary');
    expect(summary).toHaveTextContent('0 created, 1 failed');
    // addOptimistic must NOT have been called for failed tasks
    expect(mockAddOptimistic).not.toHaveBeenCalled();
  });

  it('calls addOptimistic only for successful tasks in a mixed batch', async () => {
    const user = userEvent.setup();
    const goodTask = makeTask({ id: 'good-task', title: 'Good task' });
    apiMock.createTask
      .mockResolvedValueOnce(goodTask)
      .mockRejectedValueOnce(new Error('Server error'));

    renderDialog();

    const textarea = screen.getByTestId('bulk-paste-textarea');
    await user.click(textarea);
    await user.paste('Good task\nBad task');
    await user.type(screen.getByPlaceholderText(REPO_PLACEHOLDER), '/dev/octomux');

    const submit = screen.getByTestId('bulk-create-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    const summary = await screen.findByTestId('bulk-summary');
    expect(summary).toHaveTextContent('1 created, 1 failed');
    // Only the successful task gets optimistic injection
    expect(mockAddOptimistic).toHaveBeenCalledTimes(1);
    expect(mockAddOptimistic).toHaveBeenCalledWith(goodTask);
  });
});
