import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ChatPage from './ChatPage';
import { renderWithRouter } from '../test-helpers';
import { OrchestratorProvider } from '@/lib/orchestrator-context';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

vi.mock('@/components/TerminalView', () => ({
  TerminalView: ({ wsUrl }: { wsUrl: string }) => (
    <div data-testid="terminal-view" data-ws-url={wsUrl} />
  ),
}));

const orchestratorAgent = {
  id: 'orchestrator',
  task_id: null,
  label: 'Orchestrator',
  status: 'running' as const,
  pinned: true,
  tmux_session: 'octomux-orchestrator',
  window_index: 0,
  claude_session_id: null,
  hook_activity: 'active' as const,
  hook_activity_updated_at: null,
  created_at: '2026-04-24 00:00:00',
};

function renderOrchestrator() {
  return render(
    <MemoryRouter initialEntries={['/chats/orchestrator']}>
      <OrchestratorProvider>
        <Routes>
          <Route path="/chats/:id" element={<ChatPage />} />
        </Routes>
      </OrchestratorProvider>
    </MemoryRouter>,
  );
}

describe('ChatPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    apiMock.orchestratorStatus.mockResolvedValue({
      running: true,
      session: 'octomux-orchestrator',
    });
    apiMock.orchestratorSend.mockResolvedValue({ ok: true, running: true });
  });

  it('fetches a chat and renders the terminal', async () => {
    const chat = {
      id: 'chat-xyz',
      task_id: null,
      label: 'My chat',
      status: 'running',
      pinned: false,
      tmux_session: 'octomux-chat-chat-xyz',
      window_index: 0,
      claude_session_id: null,
      hook_activity: 'active',
      hook_activity_updated_at: null,
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

  it('orchestrator chat shows RUNNING pill and attaches orchestrator terminal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/chats/orchestrator') {
          return { ok: true, status: 200, json: async () => orchestratorAgent } as Response;
        }
        throw new Error('unexpected fetch ' + url);
      }),
    );

    renderOrchestrator();

    await waitFor(() => {
      expect(screen.getByTestId('orchestrator-running-pill')).toBeInTheDocument();
    });
    expect(screen.getByText('// ORCHESTRATOR')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-view')).toHaveAttribute(
      'data-ws-url',
      '/ws/terminal/orchestrator',
    );
  });

  it('orchestrator help chip opens a help card', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/chats/orchestrator') {
          return { ok: true, status: 200, json: async () => orchestratorAgent } as Response;
        }
        throw new Error('unexpected fetch ' + url);
      }),
    );

    const user = userEvent.setup();
    renderOrchestrator();

    const chip = await screen.findByTestId('orchestrator-help-chip');
    expect(screen.queryByTestId('orchestrator-help-card')).not.toBeInTheDocument();
    await user.click(chip);
    expect(screen.getByTestId('orchestrator-help-card')).toBeInTheDocument();
  });

  it('orchestrator prompt input sends via api.orchestratorSend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/chats/orchestrator') {
          return { ok: true, status: 200, json: async () => orchestratorAgent } as Response;
        }
        throw new Error('unexpected fetch ' + url);
      }),
    );

    renderOrchestrator();
    const input = await screen.findByTestId('orchestrator-prompt-input');
    fireEvent.change(input, { target: { value: 'list tasks' } });
    // submit via Enter key press (form submit triggers on Enter without meta too)
    const form = input.closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(apiMock.orchestratorSend).toHaveBeenCalledWith('list tasks');
    });
  });

  it('shows "Starting orchestrator..." when not running', async () => {
    apiMock.orchestratorStatus.mockResolvedValue({ running: false, session: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/chats/orchestrator') {
          return { ok: true, status: 200, json: async () => orchestratorAgent } as Response;
        }
        throw new Error('unexpected fetch ' + url);
      }),
    );

    renderOrchestrator();
    await screen.findByText(/Starting orchestrator/i);
    expect(screen.queryByTestId('orchestrator-running-pill')).not.toBeInTheDocument();
  });
});
