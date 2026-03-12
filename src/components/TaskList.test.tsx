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

  it('shows empty state when no tasks', () => {
    renderWithRouter(<TaskList tasks={[]} onClose={onClose} onDelete={onDelete} />);
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.getByText('Create a task to get started')).toBeInTheDocument();
  });

  // ─── Rendering tasks ─────────────────────────────────────────────────────

  it('renders one task card', () => {
    renderWithRouter(<TaskList tasks={[makeTask()]} onClose={onClose} onDelete={onDelete} />);
    expect(screen.getByText('Fix order validation')).toBeInTheDocument();
  });

  it('renders multiple task cards', () => {
    const tasks = [
      makeTask({ id: 't1', title: 'Task One' }),
      makeTask({ id: 't2', title: 'Task Two' }),
      makeTask({ id: 't3', title: 'Task Three' }),
    ];
    renderWithRouter(<TaskList tasks={tasks} onClose={onClose} onDelete={onDelete} />);
    expect(screen.getByText('Task One')).toBeInTheDocument();
    expect(screen.getByText('Task Two')).toBeInTheDocument();
    expect(screen.getByText('Task Three')).toBeInTheDocument();
  });

  it('does not show empty state when tasks exist', () => {
    renderWithRouter(<TaskList tasks={[makeTask()]} onClose={onClose} onDelete={onDelete} />);
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
  });
});
