import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionsInbox } from './SessionsInbox';
import { _resetInboxStore } from '@/lib/inbox';
import { makeTask } from '../test-helpers';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

const eventCallbacks: Set<(event: any) => void> = new Set();
const unsubscribe = vi.fn();
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn((cb: (event: any) => void) => {
    eventCallbacks.add(cb);
    return () => {
      eventCallbacks.delete(cb);
      unsubscribe();
    };
  }),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

function fireEvent(event: any): void {
  for (const cb of eventCallbacks) cb(event);
}

const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function renderInbox() {
  return render(
    <MemoryRouter>
      <SessionsInbox />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInboxStore();
  eventCallbacks.clear();
  mockNavigate.mockReset();
  apiMock.getInbox.mockResolvedValue({ needs_you: [], activity: [] });
});

afterEach(() => {
  _resetInboxStore();
});

describe('SessionsInbox', () => {
  it('renders "caught up" when all sections empty', async () => {
    renderInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('inbox-section-awaiting_reply')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-section-errored')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-section-activity')).not.toBeInTheDocument();
  });

  it('buckets errored tasks into ERRORED, not AWAITING REPLY', async () => {
    apiMock.getInbox.mockResolvedValue({
      needs_you: [
        makeTask({ id: 'err1', title: 'Failed Task', runtime_state: 'error', error: 'Boom' }),
        makeTask({
          id: 'wait1',
          title: 'Waiting Task',
          runtime_state: 'running',
          pending_prompts: [
            {
              id: 'pp1',
              task_id: 'wait1',
              agent_id: null,
              agent_label: 'a',
              session_id: 's',
              tool_name: 'Bash',
              tool_input: {},
              status: 'pending',
              created_at: '',
              resolved_at: null,
            },
          ],
        }),
      ],
      activity: [],
    });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-row-err1')).toBeInTheDocument());

    const erroredSection = screen.getByTestId('inbox-section-errored');
    const awaitingSection = screen.getByTestId('inbox-section-awaiting_reply');

    expect(erroredSection).toHaveTextContent(/errored/i);
    expect(erroredSection).toHaveTextContent('Failed Task');
    expect(erroredSection).not.toHaveTextContent('Waiting Task');

    expect(awaitingSection).toHaveTextContent(/awaiting reply/i);
    expect(awaitingSection).toHaveTextContent('Waiting Task');
    expect(awaitingSection).not.toHaveTextContent('Failed Task');
  });

  it('renders Reply → button on awaiting-reply rows and navigates to composer', async () => {
    const user = userEvent.setup();
    apiMock.getInbox.mockResolvedValue({
      needs_you: [
        makeTask({
          id: 'wait1',
          runtime_state: 'running',
          pending_prompts: [
            {
              id: 'pp1',
              task_id: 'wait1',
              agent_id: null,
              agent_label: 'a',
              session_id: 's',
              tool_name: 'Bash',
              tool_input: {},
              status: 'pending',
              created_at: '',
              resolved_at: null,
            },
          ],
        }),
      ],
      activity: [],
    });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-reply-wait1')).toBeInTheDocument());
    expect(screen.queryByTestId('inbox-reply-err1')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('inbox-reply-wait1'));
    expect(mockNavigate).toHaveBeenCalledWith('/?add_agent=wait1');
  });

  it('collapses activity beyond 3 items with tap-to-expand', async () => {
    const user = userEvent.setup();
    apiMock.getInbox.mockResolvedValue({
      needs_you: [],
      activity: [
        makeTask({ id: 'a1', runtime_state: 'idle' }),
        makeTask({ id: 'a2', runtime_state: 'idle' }),
        makeTask({ id: 'a3', runtime_state: 'idle' }),
        makeTask({ id: 'a4', runtime_state: 'idle' }),
        makeTask({ id: 'a5', runtime_state: 'idle' }),
      ],
    });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-section-activity')).toBeInTheDocument());
    expect(screen.getByTestId('inbox-row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-row-a2')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-row-a3')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-row-a4')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('inbox-activity-toggle'));
    expect(screen.getByTestId('inbox-row-a4')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-row-a5')).toBeInTheDocument();
  });

  it('clicking a row navigates to the task', async () => {
    const user = userEvent.setup();
    apiMock.getInbox.mockResolvedValue({
      needs_you: [makeTask({ id: 'n1', runtime_state: 'error' })],
      activity: [],
    });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-row-n1')).toBeInTheDocument());
    // Click the inner title button (not the reply button). For errored rows, only the title exists.
    await user.click(screen.getByTestId('inbox-row-n1').querySelector('button') as HTMLElement);
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/n1');
  });

  it('mark-all-read calls API and refetches', async () => {
    const user = userEvent.setup();
    apiMock.getInbox
      .mockResolvedValueOnce({ needs_you: [makeTask({ id: 'n1', runtime_state: 'error' })], activity: [] })
      .mockResolvedValueOnce({ needs_you: [], activity: [] });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-mark-all-read')).toBeInTheDocument());
    await user.click(screen.getByTestId('inbox-mark-all-read'));

    expect(apiMock.markAllTasksViewed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeInTheDocument());
  });

  it('refetches when a task:* WebSocket event fires (debounced)', async () => {
    vi.useFakeTimers();
    try {
      apiMock.getInbox.mockResolvedValue({ needs_you: [], activity: [] });
      renderInbox();

      await vi.waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(1));

      act(() => {
        fireEvent({ type: 'task:updated', payload: { taskId: 't1' } });
        fireEvent({ type: 'task:updated', payload: { taskId: 't2' } });
        fireEvent({ type: 'task:created', payload: { taskId: 't3' } });
      });

      expect(apiMock.getInbox).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(300);
      });

      await vi.waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
