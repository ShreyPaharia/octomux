/**
 * Tests for the show-trash toggle and delete-all button in TaskBoard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter, makeTask } from '../test-helpers';
import { TaskBoard } from './TaskBoard';
import type { Task } from '../../server/types';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('./CustomToast', () => ({ showToast: vi.fn(), CustomToast: vi.fn() }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
}));

const { mockNavigate: _mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTasks(overrides: Partial<Task>[] = []): Task[] {
  return overrides.map((o, i) => makeTask({ id: `task-${i}`, title: `Task ${i}`, ...o }));
}

function renderBoard(tasks: Task[] = []) {
  return renderWithRouter(<TaskBoard tasks={tasks} />);
}

// ─── Show-trash toggle ────────────────────────────────────────────────────────

describe('Show trash toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage to get default (off) state
    localStorage.removeItem('octomux-board-show-trash');
  });

  it('hides trash column by default', () => {
    const tasks = makeTasks([{ id: 't1', deleted_at: '2026-05-28T00:00:00Z' }]);
    renderBoard(tasks);

    expect(screen.queryByTestId('board-column-trash')).not.toBeInTheDocument();
  });

  it("shows 'Show trash' toggle button", () => {
    renderBoard();
    expect(screen.getByTestId('show-trash-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('show-trash-toggle')).toHaveTextContent('Show trash');
  });

  it('shows trash count in toggle when not showing trash', () => {
    const tasks = makeTasks([
      { id: 't1', deleted_at: '2026-05-28T00:00:00Z' },
      { id: 't2', deleted_at: '2026-05-28T00:00:00Z' },
    ]);
    renderBoard(tasks);

    expect(screen.getByTestId('show-trash-toggle')).toHaveTextContent('(2)');
  });

  it('shows trash column after clicking toggle', async () => {
    const user = userEvent.setup();
    const tasks = makeTasks([{ id: 't1', deleted_at: '2026-05-28T00:00:00Z' }]);
    renderBoard(tasks);

    await user.click(screen.getByTestId('show-trash-toggle'));

    expect(screen.getByTestId('board-column-trash')).toBeInTheDocument();
    expect(screen.getByTestId('show-trash-toggle')).toHaveTextContent('Hide trash');
  });

  it('persists show-trash state to localStorage', async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.click(screen.getByTestId('show-trash-toggle'));
    expect(localStorage.getItem('octomux-board-show-trash')).toBe('true');

    await user.click(screen.getByTestId('show-trash-toggle'));
    expect(localStorage.getItem('octomux-board-show-trash')).toBe('false');
  });

  it('reads initial state from localStorage', () => {
    localStorage.setItem('octomux-board-show-trash', 'true');
    const tasks = makeTasks([{ id: 't1', deleted_at: '2026-05-28T00:00:00Z' }]);
    renderBoard(tasks);

    expect(screen.getByTestId('board-column-trash')).toBeInTheDocument();
  });
});

// ─── Delete all done button ───────────────────────────────────────────────────

describe('Delete all done button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('octomux-board-show-trash');
    apiMock.deleteDone = vi.fn().mockResolvedValue({ deleted: 2 });
  });

  it("renders 'Delete all' button on Done column", () => {
    const tasks = makeTasks([
      { id: 't1', workflow_status: 'done' },
      { id: 't2', workflow_status: 'done' },
    ]);
    renderBoard(tasks);

    expect(screen.getByTestId('delete-all-done-btn')).toBeInTheDocument();
    expect(screen.getByTestId('delete-all-done-btn')).toHaveTextContent('Delete all (2)');
  });

  it('disables delete-all when Done column is empty', () => {
    renderBoard(); // no tasks

    const btn = screen.getByTestId('delete-all-done-btn');
    expect(btn).toBeDisabled();
  });

  it('calls taskApi.deleteDone when clicked', async () => {
    const user = userEvent.setup();
    const tasks = makeTasks([{ id: 't1', workflow_status: 'done' }]);
    renderBoard(tasks);

    await user.click(screen.getByTestId('delete-all-done-btn'));

    await waitFor(() => {
      expect(apiMock.deleteDone).toHaveBeenCalledTimes(1);
    });
  });

  it('does not render delete-all on non-Done columns', () => {
    renderBoard();

    // Check that no delete button is in the backlog column
    const backlogCol = screen.getByTestId('board-column-backlog');
    expect(backlogCol.querySelector('[data-testid="delete-all-done-btn"]')).toBeNull();
  });
});
