import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import ChatPage from './ChatPage';
import { renderWithRouter } from '../test-helpers';

const { apiProxy } = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());
vi.mock('@/lib/api', () => ({ api: apiProxy }));

vi.mock('@/components/TerminalView', () => ({
  TerminalView: ({ wsUrl }: { wsUrl: string }) => (
    <div data-testid="terminal-view" data-ws-url={wsUrl} />
  ),
}));

describe('ChatPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('fetches a chat and renders the terminal', async () => {
    const chat = {
      id: 'chat-xyz',
      task_id: null,
      label: 'My chat',
      status: 'running',
      tmux_session: 'octomux-chat-chat-xyz',
      window_index: 0,
      claude_session_id: null,
      hook_activity: 'active',
      hook_activity_updated_at: null,
      agent: null,
      created_at: '2026-04-24 00:00:00',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/chats/chat-xyz') {
          return { ok: true, status: 200, json: async () => chat } as Response;
        }
        throw new Error('unexpected fetch ' + url);
      }),
    );

    renderWithRouter(<ChatPage />, { path: '/chats/:id', route: '/chats/chat-xyz' });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-view')).toHaveAttribute(
        'data-ws-url',
        '/ws/terminal/chat/chat-xyz',
      );
    });
    expect(screen.getByText('My chat')).toBeInTheDocument();
  });

  it('renders the agent badge when chat has an agent', async () => {
    const chat = {
      id: 'chat-orc',
      task_id: null,
      label: 'Run as orchestrator',
      status: 'running',
      tmux_session: 'octomux-chat-chat-orc',
      window_index: 0,
      claude_session_id: null,
      hook_activity: 'active',
      hook_activity_updated_at: null,
      agent: 'orchestrator',
      created_at: '2026-04-24 00:00:00',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => chat }) as Response),
    );

    renderWithRouter(<ChatPage />, { path: '/chats/:id', route: '/chats/chat-orc' });
    await waitFor(() => {
      expect(screen.getByTitle('Running as agent: orchestrator')).toBeInTheDocument();
    });
  });

  it('shows an error message when the chat is not found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );

    renderWithRouter(<ChatPage />, { path: '/chats/:id', route: '/chats/missing' });

    await waitFor(() => {
      expect(screen.getByText(/chat not found/i)).toBeInTheDocument();
    });
  });
});
