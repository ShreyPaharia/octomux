import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskCard } from './TaskCard';
import { renderWithRouter, makeTask } from '../test-helpers';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('TaskCard', () => {
  const onClose = vi.fn();
  const onDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Content rendering (table-driven) ─────────────────────────────────────

  const contentCases = [
    { name: 'title', task: makeTask(), expected: 'Fix order validation' },
    { name: 'description', task: makeTask(), expected: 'Add negative quantity checks' },
    { name: 'repo name', task: makeTask(), expected: 'my-repo' },
    { name: 'branch', task: makeTask(), expected: 'agents/test-task-01' },
  ];

  it.each(contentCases)('renders $name', ({ task, expected }) => {
    renderWithRouter(<TaskCard task={task} onClose={onClose} onDelete={onDelete} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  // ─── PR link ──────────────────────────────────────────────────────────────

  it('shows PR link when pr_url is set', () => {
    const task = makeTask({ pr_url: 'https://github.com/org/repo/pull/42', pr_number: 42 });
    renderWithRouter(<TaskCard task={task} onClose={onClose} onDelete={onDelete} />);
    const link = screen.getByRole('link', { name: /PR #\s*42/ });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/42');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('does not show PR link when pr_url is null', () => {
    renderWithRouter(<TaskCard task={makeTask()} onClose={onClose} onDelete={onDelete} />);
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
  });

  // ─── Error display ────────────────────────────────────────────────────────

  it('shows error span when error is set', () => {
    const task = makeTask({ status: 'error', error: 'Something failed' });
    renderWithRouter(<TaskCard task={task} onClose={onClose} onDelete={onDelete} />);
    const errorSpan = screen.getByTitle('Something failed');
    expect(errorSpan).toBeInTheDocument();
    expect(errorSpan).toHaveTextContent('Error');
  });

  it('does not show error span when error is null', () => {
    renderWithRouter(<TaskCard task={makeTask()} onClose={onClose} onDelete={onDelete} />);
    expect(screen.queryByText('Error')).not.toBeInTheDocument();
  });

  // ─── Branch display ───────────────────────────────────────────────────────

  it('does not render branch when null', () => {
    const task = makeTask({ branch: null });
    renderWithRouter(<TaskCard task={task} onClose={onClose} onDelete={onDelete} />);
    expect(screen.queryByText(/agents\//)).not.toBeInTheDocument();
  });

  // ─── Navigation ───────────────────────────────────────────────────────────

  it('navigates to task detail on card click', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TaskCard task={makeTask()} onClose={onClose} onDelete={onDelete} />);
    await user.click(screen.getByText('Fix order validation'));
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/test-task-01');
  });

  // ─── Close (running tasks) ────────────────────────────────────────────────

  it('shows close button for running tasks', () => {
    renderWithRouter(<TaskCard task={makeTask()} onClose={onClose} onDelete={onDelete} />);
    expect(screen.getByTitle('Close task')).toBeInTheDocument();
    expect(screen.queryByTitle('Delete task')).not.toBeInTheDocument();
  });

  it('calls onClose with task id when close button clicked', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TaskCard task={makeTask()} onClose={onClose} onDelete={onDelete} />);
    await user.click(screen.getByTitle('Close task'));
    expect(onClose).toHaveBeenCalledWith('test-task-01');
  });

  it('close click does not trigger navigation', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TaskCard task={makeTask()} onClose={onClose} onDelete={onDelete} />);
    await user.click(screen.getByTitle('Close task'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows close button for setting_up tasks', () => {
    renderWithRouter(
      <TaskCard task={makeTask({ status: 'setting_up' })} onClose={onClose} onDelete={onDelete} />,
    );
    expect(screen.getByTitle('Close task')).toBeInTheDocument();
    expect(screen.queryByTitle('Delete task')).not.toBeInTheDocument();
  });

  // ─── Delete (closed/error/draft tasks) ──────────────────────────────────

  it.each(['closed', 'error', 'draft'] as const)('shows delete button for %s tasks', (status) => {
    renderWithRouter(
      <TaskCard task={makeTask({ status })} onClose={onClose} onDelete={onDelete} />,
    );
    expect(screen.getByTitle('Delete task')).toBeInTheDocument();
    expect(screen.queryByTitle('Close task')).not.toBeInTheDocument();
  });

  it('calls onDelete with task id when delete button clicked on closed task', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <TaskCard task={makeTask({ status: 'closed' })} onClose={onClose} onDelete={onDelete} />,
    );
    await user.click(screen.getByTitle('Delete task'));
    expect(onDelete).toHaveBeenCalledWith('test-task-01');
  });

  // ─── Repo name extraction (table-driven) ──────────────────────────────────

  const repoPaths = [
    { path: '/Users/dev/projects/nucleus', expected: 'nucleus' },
    { path: '/tmp/my-repo', expected: 'my-repo' },
    { path: '/a/b/c/d', expected: 'd' },
  ];

  it.each(repoPaths)('extracts repo name "$expected" from "$path"', ({ path, expected }) => {
    renderWithRouter(
      <TaskCard task={makeTask({ repo_path: path })} onClose={onClose} onDelete={onDelete} />,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
