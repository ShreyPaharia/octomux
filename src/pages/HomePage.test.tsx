import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TasksProvider } from '@/lib/tasks-context';
import HomePage from './HomePage';
import { makeTask } from '../test-helpers';
import type { Task } from '../../server/types';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

const mockTasksRef = { current: [] as Task[] };
vi.mock('@/lib/hooks', () => ({
  useTasks: () => ({
    tasks: mockTasksRef.current,
    loading: false,
    error: null,
    refresh: vi.fn(),
    addOptimistic: vi.fn(),
  }),
  useAgents: () => ({ agents: [], loading: false, error: null, refresh: vi.fn() }),
  useHarnesses: () => ({
    harnesses: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        sessionIdMode: 'orchestrator-assigned',
      },
      { id: 'cursor', displayName: 'Cursor', sessionIdMode: 'harness-issued' },
    ],
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

  it('renders an inline search input next to the H1', () => {
    renderHome('/');
    const search = screen.getByTestId('home-search');
    expect(search).toBeInTheDocument();
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();
  });

  it('renders the Inbox eyebrow above the welcome heading', () => {
    renderHome('/');
    const eyebrow = screen.getByTestId('home-eyebrow');
    expect(eyebrow).toHaveTextContent('Inbox');
    expect(eyebrow).toHaveTextContent(/inbox zero|sessions? want/i);
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
