/**
 * B3: Tests for the show-archived toggle and archive-all button in TaskBoard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter, makeTask } from '../test-helpers';
import { TaskBoard } from './TaskBoard';
import type { Task } from '../../server/types';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));
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

// ─── Show-archived toggle ─────────────────────────────────────────────────────

describe('Show archived toggle (B3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage to get default (off) state
    localStorage.removeItem('octomux-board-show-archived');
  });

  it('hides archived column by default', () => {
    const tasks = makeTasks([{ id: 't1', workflow_status: 'archived' }]);
    renderBoard(tasks);

    expect(screen.queryByTestId('board-column-archived')).not.toBeInTheDocument();
  });

  it('shows "Show archived" toggle button', () => {
    renderBoard();
    expect(screen.getByTestId('show-archived-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('show-archived-toggle')).toHaveTextContent('Show archived');
  });

  it('shows archived count in toggle when not showing archived', () => {
    const tasks = makeTasks([
      { id: 't1', workflow_status: 'archived' },
      { id: 't2', workflow_status: 'archived' },
    ]);
    renderBoard(tasks);

    expect(screen.getByTestId('show-archived-toggle')).toHaveTextContent('(2)');
  });

  it('shows archived column after clicking toggle', async () => {
    const user = userEvent.setup();
    const tasks = makeTasks([{ id: 't1', workflow_status: 'archived' }]);
    renderBoard(tasks);

    await user.click(screen.getByTestId('show-archived-toggle'));

    expect(screen.getByTestId('board-column-archived')).toBeInTheDocument();
    expect(screen.getByTestId('show-archived-toggle')).toHaveTextContent('Hide archived');
  });

  it('persists show-archived state to localStorage', async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.click(screen.getByTestId('show-archived-toggle'));
    expect(localStorage.getItem('octomux-board-show-archived')).toBe('true');

    await user.click(screen.getByTestId('show-archived-toggle'));
    expect(localStorage.getItem('octomux-board-show-archived')).toBe('false');
  });

  it('reads initial state from localStorage', () => {
    localStorage.setItem('octomux-board-show-archived', 'true');
    const tasks = makeTasks([{ id: 't1', workflow_status: 'archived' }]);
    renderBoard(tasks);

    expect(screen.getByTestId('board-column-archived')).toBeInTheDocument();
  });
});

// ─── Archive all done button ──────────────────────────────────────────────────

describe('Archive all done button (B3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('octomux-board-show-archived');
    apiMock.archiveDone = vi.fn().mockResolvedValue({ archived: 2 });
  });

  it('renders archive button on Done column', () => {
    const tasks = makeTasks([
      { id: 't1', workflow_status: 'done' },
      { id: 't2', workflow_status: 'done' },
    ]);
    renderBoard(tasks);

    expect(screen.getByTestId('archive-all-done-btn')).toBeInTheDocument();
    expect(screen.getByTestId('archive-all-done-btn')).toHaveTextContent('Archive all (2)');
  });

  it('disables archive button when Done column is empty', () => {
    renderBoard(); // no tasks

    const btn = screen.getByTestId('archive-all-done-btn');
    expect(btn).toBeDisabled();
  });

  it('calls api.archiveDone when clicked', async () => {
    const user = userEvent.setup();
    const tasks = makeTasks([{ id: 't1', workflow_status: 'done' }]);
    renderBoard(tasks);

    await user.click(screen.getByTestId('archive-all-done-btn'));

    await waitFor(() => {
      expect(apiMock.archiveDone).toHaveBeenCalledTimes(1);
    });
  });

  it('does not render archive button on non-Done columns', () => {
    renderBoard();

    // Check that no archive button is in the backlog column
    const backlogCol = screen.getByTestId('board-column-backlog');
    expect(backlogCol.querySelector('[data-testid="archive-all-done-btn"]')).toBeNull();
  });
});
