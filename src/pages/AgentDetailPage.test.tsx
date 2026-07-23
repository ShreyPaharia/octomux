import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentDetailPage from './AgentDetailPage';
import { renderWithRouter } from '../test-helpers';
import type { AgentWithStatus } from '@/lib/api/agentsApi';

const { taskApiProxy, reviewApiProxy, configApiProxy, agentsApiProxy, apiMock } = await vi.hoisted(
  async () => (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/api/agentsApi', () => ({ agentsApi: agentsApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { routerMockFactory, mockNavigate } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', async (importOriginal) => {
  const withNav = await routerMockFactory(importOriginal);
  return { ...withNav, useParams: () => ({ id: 'agent-1' }) };
});

// ─── WS mock (AgentSessionChat opens its own socket in the Sessions tab) ─────

interface MockWs {
  readyState: number;
  sentMessages: string[];
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: Event) => void) | null;
  send: (data: string) => void;
  close: () => void;
}

function makeWsMock(): MockWs {
  return {
    readyState: 0,
    sentMessages: [],
    onmessage: null,
    onopen: null,
    onclose: null,
    onerror: null,
    send(data: string) {
      this.sentMessages.push(data);
    },
    close() {
      this.readyState = 3;
      this.onclose?.();
    },
  };
}

vi.stubGlobal(
  'WebSocket',
  vi.fn(() => makeWsMock()),
);

function makeAgent(overrides: Partial<AgentWithStatus> = {}): AgentWithStatus {
  return {
    id: 'agent-1',
    name: 'support-bot',
    system_prompt: 'You help customers.',
    channel: null,
    channel_config: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    status: 'stopped',
    session_id: null,
    ...overrides,
  };
}

describe('AgentDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.match(/\/messages$/)) {
          return { ok: true, status: 200, json: async () => [] } as Response;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Config tab', () => {
    it('loads the agent config into the form', async () => {
      apiMock.get.mockResolvedValue(
        makeAgent({ name: 'support-bot', system_prompt: 'Be nice.', status: 'working' }),
      );
      renderWithRouter(<AgentDetailPage />);

      await waitFor(() => {
        expect(screen.getByTestId('agent-detail-name')).toHaveValue('support-bot');
      });
      expect(screen.getByTestId('agent-detail-system-prompt')).toHaveValue('Be nice.');
      expect(screen.getByText('working')).toBeInTheDocument();
    });

    it('saves edits via agentsApi.update', async () => {
      const user = userEvent.setup();
      apiMock.get.mockResolvedValue(makeAgent());
      apiMock.update.mockResolvedValue(makeAgent({ name: 'renamed-bot' }));
      renderWithRouter(<AgentDetailPage />);

      await waitFor(() =>
        expect(screen.getByTestId('agent-detail-name')).toHaveValue('support-bot'),
      );

      await user.clear(screen.getByTestId('agent-detail-name'));
      await user.type(screen.getByTestId('agent-detail-name'), 'renamed-bot');
      await user.click(screen.getByTestId('agent-detail-save'));

      await waitFor(() =>
        expect(apiMock.update).toHaveBeenCalledWith('agent-1', {
          name: 'renamed-bot',
          system_prompt: 'You help customers.',
          channel: null,
          channel_config: null,
        }),
      );
    });

    it('serializes a thread key into channel_config JSON on save', async () => {
      const user = userEvent.setup();
      apiMock.get.mockResolvedValue(makeAgent({ channel: 'telegram' }));
      apiMock.update.mockResolvedValue(makeAgent({ channel: 'telegram' }));
      renderWithRouter(<AgentDetailPage />);

      await waitFor(() =>
        expect(screen.getByTestId('agent-detail-channel')).toHaveValue('telegram'),
      );
      await user.type(screen.getByTestId('agent-detail-thread-key'), 'thread-9');
      await user.click(screen.getByTestId('agent-detail-save'));

      await waitFor(() =>
        expect(apiMock.update).toHaveBeenCalledWith(
          'agent-1',
          expect.objectContaining({
            channel: 'telegram',
            channel_config: JSON.stringify({ threadKey: 'thread-9' }),
          }),
        ),
      );
    });

    it('deletes the agent and navigates back to /agents after confirm', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      apiMock.get.mockResolvedValue(makeAgent());
      apiMock.remove.mockResolvedValue(undefined);
      renderWithRouter(<AgentDetailPage />);

      await waitFor(() =>
        expect(screen.getByTestId('agent-detail-name')).toHaveValue('support-bot'),
      );
      await user.click(screen.getByTestId('agent-detail-delete'));

      await waitFor(() => expect(apiMock.remove).toHaveBeenCalledWith('agent-1'));
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/agents'));
    });

    it('does not delete when the confirm dialog is dismissed', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      apiMock.get.mockResolvedValue(makeAgent());
      renderWithRouter(<AgentDetailPage />);

      await waitFor(() =>
        expect(screen.getByTestId('agent-detail-name')).toHaveValue('support-bot'),
      );
      await user.click(screen.getByTestId('agent-detail-delete'));

      expect(apiMock.remove).not.toHaveBeenCalled();
    });
  });

  describe('Sessions tab', () => {
    it('ensures the session and mounts the chat view', async () => {
      const user = userEvent.setup();
      apiMock.get.mockResolvedValue(makeAgent());
      apiMock.ensureSession.mockResolvedValue({
        id: 'conv-77',
        title: 'support-bot',
        tmux_window: null,
        claude_session_id: null,
        transcript_path: null,
        status: 'running',
        is_global_monitor: 0,
        agent_id: 'agent-1',
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      });
      renderWithRouter(<AgentDetailPage />);

      await waitFor(() =>
        expect(screen.getByTestId('agent-detail-name')).toHaveValue('support-bot'),
      );
      await user.click(screen.getByTestId('agent-tab-sessions'));

      await waitFor(() => expect(apiMock.ensureSession).toHaveBeenCalledWith('agent-1'));
      await waitFor(() => {
        expect(screen.getByTestId('agent-session-chat')).toBeInTheDocument();
      });
    });
  });
});
