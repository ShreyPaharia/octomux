import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentsPage from './AgentsPage';
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
vi.mock('react-router-dom', routerMockFactory);

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

describe('AgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no agents', async () => {
    apiMock.list.mockResolvedValue([]);
    renderWithRouter(<AgentsPage />);
    expect(await screen.findByText(/no agents yet/i)).toBeTruthy();
  });

  it('renders agent cards with status pill, channel badge, and updated_at', async () => {
    apiMock.list.mockResolvedValue([
      makeAgent({ id: 'agent-1', name: 'support-bot', status: 'working', channel: 'telegram' }),
      makeAgent({ id: 'agent-2', name: 'idle-bot', status: 'idle', channel: null }),
      makeAgent({ id: 'agent-3', name: 'stopped-bot', status: 'stopped', channel: null }),
    ]);
    renderWithRouter(<AgentsPage />);

    expect(await screen.findByTestId('agent-card-agent-1')).toBeTruthy();
    expect(screen.getByTestId('agent-card-agent-2')).toBeTruthy();
    expect(screen.getByTestId('agent-card-agent-3')).toBeTruthy();

    expect(screen.getByText('support-bot')).toBeTruthy();
    expect(screen.getByText('working')).toBeTruthy();
    expect(screen.getByText('idle')).toBeTruthy();
    expect(screen.getByText('stopped')).toBeTruthy();

    expect(screen.getByTestId('agent-channel-agent-1')).toHaveTextContent('telegram');
    expect(screen.getByTestId('agent-channel-agent-2')).toHaveTextContent('no channel');
  });

  it('navigates to /agents/:id on card click', async () => {
    const user = userEvent.setup();
    apiMock.list.mockResolvedValue([makeAgent({ id: 'agent-42' })]);
    renderWithRouter(<AgentsPage />);

    const card = await screen.findByTestId('agent-card-agent-42');
    await user.click(card);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/agents/agent-42'));
  });

  it('opens the new agent dialog and submits, then refreshes the list', async () => {
    const user = userEvent.setup();
    apiMock.list.mockResolvedValue([]);
    apiMock.create.mockResolvedValue(makeAgent({ id: 'agent-new', name: 'new-agent' }));
    renderWithRouter(<AgentsPage />);

    await user.click(await screen.findByTestId('new-agent-button'));
    expect(await screen.findByTestId('new-agent-dialog')).toBeInTheDocument();

    await user.type(screen.getByTestId('agent-name'), 'new-agent');
    await user.type(screen.getByTestId('agent-system-prompt'), 'Be helpful.');
    await user.selectOptions(screen.getByTestId('agent-channel'), 'telegram');
    await user.type(screen.getByTestId('agent-thread-key'), 'thread-123');

    await user.click(screen.getByTestId('new-agent-submit'));

    await waitFor(() =>
      expect(apiMock.create).toHaveBeenCalledWith({
        name: 'new-agent',
        system_prompt: 'Be helpful.',
        channel: 'telegram',
        channel_config: JSON.stringify({ threadKey: 'thread-123' }),
      }),
    );
    await waitFor(() => expect(apiMock.list).toHaveBeenCalledTimes(2));
  });

  it('disables submit until name and system prompt are filled', async () => {
    const user = userEvent.setup();
    apiMock.list.mockResolvedValue([]);
    renderWithRouter(<AgentsPage />);

    await user.click(await screen.findByTestId('new-agent-button'));
    expect(screen.getByTestId('new-agent-submit')).toBeDisabled();

    await user.type(screen.getByTestId('agent-name'), 'x');
    expect(screen.getByTestId('new-agent-submit')).toBeDisabled();

    await user.type(screen.getByTestId('agent-system-prompt'), 'y');
    expect(screen.getByTestId('new-agent-submit')).not.toBeDisabled();
  });
});
