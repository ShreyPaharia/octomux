import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { TaskList } from './TaskList';
import { renderWithRouter, makeTask } from '../test-helpers';

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

describe('TaskList', () => {
  const onClose = vi.fn();
  const onDelete = vi.fn();

  // ─── Empty state ──────────────────────────────────────────────────────────

  it('shows "no tasks" empty state when totalCount is 0', () => {
    renderWithRouter(
      <TaskList tasks={[]} totalCount={0} onClose={onClose} onDelete={onDelete} viewMode="cards" />,
    );
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.getByText('Create your first task to start running agents')).toBeInTheDocument();
  });

  it('shows "no matching" empty state when totalCount > 0 but filtered to zero', () => {
    renderWithRouter(
      <TaskList tasks={[]} totalCount={5} onClose={onClose} onDelete={onDelete} viewMode="cards" />,
    );
    expect(screen.getByText('No matching tasks')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your filters or status tab')).toBeInTheDocument();
  });

  it('renders emptyAction in no-tasks state', () => {
    renderWithRouter(
      <TaskList
        tasks={[]}
        totalCount={0}
        emptyAction={<button>Create Task</button>}
        onClose={onClose}
        onDelete={onDelete}
        viewMode="cards"
      />,
    );
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeInTheDocument();
  });

  it('does not render emptyAction in filtered state', () => {
    renderWithRouter(
      <TaskList
        tasks={[]}
        totalCount={5}
        emptyAction={<button>Create Task</button>}
        onClose={onClose}
        onDelete={onDelete}
        viewMode="cards"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Create Task' })).not.toBeInTheDocument();
  });

  // ─── Rendering tasks ─────────────────────────────────────────────────────

  it('renders one task card', () => {
    renderWithRouter(
      <TaskList tasks={[makeTask()]} onClose={onClose} onDelete={onDelete} viewMode="cards" />,
    );
    expect(screen.getByText('Fix order validation')).toBeInTheDocument();
  });

  it('renders multiple task cards', () => {
    const tasks = [
      makeTask({ id: 't1', title: 'Task One' }),
      makeTask({ id: 't2', title: 'Task Two' }),
      makeTask({ id: 't3', title: 'Task Three' }),
    ];
    renderWithRouter(
      <TaskList tasks={tasks} onClose={onClose} onDelete={onDelete} viewMode="cards" />,
    );
    expect(screen.getByText('Task One')).toBeInTheDocument();
    expect(screen.getByText('Task Two')).toBeInTheDocument();
    expect(screen.getByText('Task Three')).toBeInTheDocument();
  });

  it('does not show empty state when tasks exist', () => {
    renderWithRouter(
      <TaskList tasks={[makeTask()]} onClose={onClose} onDelete={onDelete} viewMode="cards" />,
    );
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
  });
});
