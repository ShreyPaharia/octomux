import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithRouter, makeTask } from '../test-helpers';

const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('react-router-dom', routerMockFactory);
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

const { MoveAgentDialog } = await import('./MoveAgentDialog');

beforeEach(() => {
  vi.restoreAllMocks();
  mockNavigate.mockReset();
  (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).listTasks = vi
    .fn()
    .mockResolvedValue([
      makeTask({ id: 't-running', title: 'Running work', runtime_state: 'running' }),
      makeTask({ id: 't-current', title: 'Current task', runtime_state: 'running' }),
      makeTask({ id: 't-closed', title: 'Closed', runtime_state: 'idle' }),
    ]);
  (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).moveAgentToTask = vi
    .fn()
    .mockResolvedValue({ id: 'a1', task_id: null });
});

describe('MoveAgentDialog', () => {
  it('lists only active targets and omits the current task', async () => {
    renderWithRouter(
      <MoveAgentDialog
        open={true}
        onOpenChange={() => {}}
        agentId="a1"
        currentTaskId="t-current"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('move-agent-target-t-running')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('move-agent-target-t-current')).toBeNull();
    expect(screen.queryByTestId('move-agent-target-t-closed')).toBeNull();
  });

  it('detaches by default and navigates to /chats/:id', async () => {
    renderWithRouter(
      <MoveAgentDialog open={true} onOpenChange={() => {}} agentId="a1" currentTaskId={null} />,
    );
    await waitFor(() => expect(screen.getByText(/Detach/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Move$/i }));
    await waitFor(() => {
      expect(
        (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).moveAgentToTask,
      ).toHaveBeenCalledWith('a1', null);
      expect(mockNavigate).toHaveBeenCalledWith('/chats/a1');
    });
  });

  it('moves to a chosen task and navigates to /tasks/:id', async () => {
    renderWithRouter(
      <MoveAgentDialog open={true} onOpenChange={() => {}} agentId="a1" currentTaskId={null} />,
    );
    const target = await screen.findByTestId('move-agent-target-t-running');
    fireEvent.click(target.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: /^Move$/i }));
    await waitFor(() => {
      expect(
        (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).moveAgentToTask,
      ).toHaveBeenCalledWith('a1', 't-running');
      expect(mockNavigate).toHaveBeenCalledWith('/tasks/t-running');
    });
  });

  it('shows inline error on conflict', async () => {
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).moveAgentToTask = vi
      .fn()
      .mockRejectedValue(new Error('Target task is not active (status=closed)'));
    renderWithRouter(
      <MoveAgentDialog open={true} onOpenChange={() => {}} agentId="a1" currentTaskId={null} />,
    );
    await waitFor(() => expect(screen.getByText(/Detach/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Move$/i }));
    await waitFor(() =>
      expect(screen.getByTestId('move-agent-error')).toHaveTextContent(/not active/i),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
