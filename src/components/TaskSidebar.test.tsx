import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskSidebar } from './TaskSidebar';
import { makeTask, renderWithRouter, mockApi } from '@/test-helpers';

const apiMock = mockApi();

vi.mock('@/lib/api', () => ({
  api: new Proxy(
    {},
    {
      get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock],
    },
  ),
}));
vi.mock('@/lib/event-source', () => ({ subscribe: vi.fn(() => vi.fn()) }));

const TASKS = [
  makeTask({ id: 't1', title: 'Running task', status: 'running', repo_path: '/dev/repo-a' }),
  makeTask({ id: 't2', title: 'Error task', status: 'error', repo_path: '/dev/repo-a' }),
  makeTask({ id: 't3', title: 'Draft task', status: 'draft', repo_path: '/dev/repo-a' }),
];

beforeEach(() => {
  apiMock.listTasks.mockResolvedValue(TASKS);
  localStorage.clear();
});

describe('TaskSidebar', () => {
  it('renders active tasks and excludes draft', async () => {
    renderWithRouter(<TaskSidebar />, { route: '/tasks/t1', path: '/tasks/:id' });
    expect(await screen.findByText('Running task')).toBeInTheDocument();
    expect(screen.getByText('Error task')).toBeInTheDocument();
    expect(screen.queryByText('Draft task')).not.toBeInTheDocument();
  });

  it('highlights the active task', async () => {
    renderWithRouter(<TaskSidebar />, { route: '/tasks/t1', path: '/tasks/:id' });
    const activeItem = await screen.findByText('Running task');
    expect(activeItem.closest('a')).toHaveAttribute('aria-current', 'page');
  });

  it('collapses and expands on toggle click', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TaskSidebar />, { route: '/tasks/t1', path: '/tasks/:id' });
    await screen.findByText('Running task');

    const toggle = screen.getByRole('button', { name: /collapse/i });
    await user.click(toggle);
    expect(screen.queryByText('Running task')).not.toBeVisible();

    const expand = screen.getByRole('button', { name: /expand/i });
    await user.click(expand);
    expect(await screen.findByText('Running task')).toBeVisible();
  });

  it('persists collapsed state to localStorage', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TaskSidebar />, { route: '/tasks/t1', path: '/tasks/:id' });
    await screen.findByText('Running task');

    const toggle = screen.getByRole('button', { name: /collapse/i });
    await user.click(toggle);
    expect(localStorage.getItem('octomux-sidebar-collapsed')).toBe('true');
  });

  it('shows attention count badge when tasks need attention', async () => {
    const tasksWithAttention = [
      makeTask({ id: 't1', status: 'running', derived_status: 'needs_attention' }),
      makeTask({ id: 't2', status: 'error' }),
    ];
    apiMock.listTasks.mockResolvedValue(tasksWithAttention);
    renderWithRouter(<TaskSidebar />, { route: '/tasks/t1', path: '/tasks/:id' });

    const badge = await screen.findByTestId('attention-count');
    expect(badge).toHaveTextContent('2');
  });
});
