import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import HomePage from './pages/HomePage';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('./test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
const TasksPage = lazy(() => import('./pages/TasksPage'));

async function renderAt(route: string) {
  const { TasksProvider } = await import('./lib/tasks-context');
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TasksProvider>
        <Suspense fallback={<div>Loading...</div>}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/tasks" element={<TasksPage />} />
          </Routes>
        </Suspense>
      </TasksProvider>
    </MemoryRouter>,
  );
}

describe('App routing', () => {
  it('renders HomePage at /', async () => {
    apiMock.listTasks.mockResolvedValue([]);
    await renderAt('/');
    await waitFor(() => {
      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Command center')).not.toBeInTheDocument();
  });

  it('renders TasksPage (former Dashboard) at /tasks', async () => {
    apiMock.listTasks.mockResolvedValue([]);
    // Mount TasksProvider-free: TasksPage imports useTasksContext, so we need the provider.
    const { TasksProvider } = await import('./lib/tasks-context');
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <TasksProvider>
          <Suspense fallback={<div>Loading...</div>}>
            <Routes>
              <Route path="/tasks" element={<TasksPage />} />
            </Routes>
          </Suspense>
        </TasksProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('Command center')).toBeInTheDocument();
    });
  });
});
