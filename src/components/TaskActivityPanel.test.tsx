import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test-helpers';
import { TaskActivityPanel } from './TaskActivityPanel';
import type { TaskUpdate } from '../../server/types';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
}));

function makeUpdate(overrides: Partial<TaskUpdate> = {}): TaskUpdate {
  return {
    id: 'u1',
    task_id: 'task-1',
    agent_id: null,
    kind: 'note',
    from_status: null,
    to_status: null,
    body: null,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('TaskActivityPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getTaskUpdates.mockResolvedValue([]);
  });

  it('shows "No activity yet" when no updates', async () => {
    renderWithRouter(<TaskActivityPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByText('No activity yet.')).toBeInTheDocument();
    });
  });

  it('renders note updates', async () => {
    apiMock.getTaskUpdates.mockResolvedValue([
      makeUpdate({ id: 'u1', kind: 'note', body: 'This is a test note' }),
    ]);
    renderWithRouter(<TaskActivityPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByText('This is a test note')).toBeInTheDocument();
    });
  });

  it('renders transition updates with from/to status', async () => {
    apiMock.getTaskUpdates.mockResolvedValue([
      makeUpdate({
        id: 'u2',
        kind: 'transition',
        from_status: 'backlog',
        to_status: 'in_progress',
        body: null,
      }),
    ]);
    renderWithRouter(<TaskActivityPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByText('backlog → in_progress')).toBeInTheDocument();
    });
  });

  it('shows agent attribution when agent_id is set', async () => {
    apiMock.getTaskUpdates.mockResolvedValue([
      makeUpdate({ id: 'u3', kind: 'summary', agent_id: 'agent-abc', body: 'Summary body' }),
    ]);
    renderWithRouter(<TaskActivityPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByText('agent: agent-abc')).toBeInTheDocument();
    });
  });

  it('shows "human" when agent_id is null', async () => {
    apiMock.getTaskUpdates.mockResolvedValue([
      makeUpdate({ id: 'u4', kind: 'note', agent_id: null, body: 'Human note' }),
    ]);
    renderWithRouter(<TaskActivityPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByText('human')).toBeInTheDocument();
    });
  });

  it('calls getTaskUpdates with the task id', async () => {
    renderWithRouter(<TaskActivityPanel taskId="my-task-id" />);
    await waitFor(() => {
      expect(apiMock.getTaskUpdates).toHaveBeenCalledWith('my-task-id', 50);
    });
  });

  it('renders multiple updates in order', async () => {
    apiMock.getTaskUpdates.mockResolvedValue([
      makeUpdate({
        id: 'first',
        kind: 'note',
        body: 'First note',
        created_at: '2026-01-01 01:00:00',
      }),
      makeUpdate({
        id: 'second',
        kind: 'note',
        body: 'Second note',
        created_at: '2026-01-01 02:00:00',
      }),
    ]);
    renderWithRouter(<TaskActivityPanel taskId="task-1" />);
    await waitFor(() => {
      expect(screen.getByText('First note')).toBeInTheDocument();
      expect(screen.getByText('Second note')).toBeInTheDocument();
    });
  });
});
