import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TasksProvider } from '@/lib/tasks-context';
import HomePage from './HomePage';
import { makeTask } from '../test-helpers';
import type { Task } from '../../server/types';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

const mockTasksRef = { current: [] as Task[] };
vi.mock('@/lib/hooks', () => ({
  useTasks: () => ({
    tasks: mockTasksRef.current,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function renderHome(route = '/', opts: { tasks?: Task[] } = {}) {
  mockTasksRef.current = opts.tasks ?? [];
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TasksProvider>
        <HomePage />
      </TasksProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
  mockTasksRef.current = [];
});

describe('HomePage', () => {
  it('renders welcome heading + Composer + sessions-inbox slot', () => {
    renderHome('/');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/welcome back/i);
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.getByTestId('sessions-inbox-slot')).toBeInTheDocument();
  });

  it('renders the ⌘K jump affordance next to the H1', () => {
    renderHome('/');
    const jump = screen.getByTestId('home-jump-palette');
    expect(jump).toHaveTextContent(/⌘\s*K/);
    expect(jump).toHaveTextContent(/jump/);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveClass('text-[32px]');
  });

  it('renders first-run CTA when there are no tasks', () => {
    renderHome('/', { tasks: [] });
    expect(screen.getByTestId('home-first-run')).toBeInTheDocument();
    expect(screen.getByTestId('home-first-run-cta')).toHaveTextContent(/create your first task/i);
  });

  it('clicking first-run CTA dispatches focus-composer event', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    window.addEventListener('focus-composer', spy);
    try {
      renderHome('/', { tasks: [] });
      await user.click(screen.getByTestId('home-first-run-cta'));
      expect(spy).toHaveBeenCalled();
    } finally {
      window.removeEventListener('focus-composer', spy);
    }
  });

  it('hydrates composer from URL with repo + fork_of, then submits', async () => {
    const user = userEvent.setup();
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'spawned' }));
    renderHome('/?repo=%2Fusers%2Fdev%2Focto&mode=new&branch=agents%2Fabc&fork_of=abc', {
      tasks: [makeTask({ id: 'abc', title: 'Auth Rewrite' })],
    });
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/forking from auth rewrite/i);
    await user.type(screen.getByTestId('composer-prompt'), 'pick up the PR work');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          run_mode: 'new',
          repo_path: '/users/dev/octo',
          base_branch: 'agents/abc',
        }),
      );
    });
    expect(mockNavigate).toHaveBeenLastCalledWith('/tasks/spawned');
  });
});
