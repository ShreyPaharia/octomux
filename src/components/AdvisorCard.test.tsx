/**
 * src/components/AdvisorCard.test.tsx
 *
 * The home-page advisor entry point: starter questions + free input, which
 * ensure the advisor session and swap to the inline session chat.
 */

import { describe, it, expect, vi, beforeEach } from '../bun-test.js';

const advisorSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/agentsApi', () => ({
  agentsApi: { advisorSession: advisorSessionMock },
}));

const chatPropsSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/AgentSessionChat', () => ({
  AgentSessionChat: (props: { convId: string; initialMessage?: string }) => {
    chatPropsSpy(props);
    return <div data-testid="mock-session-chat">chat:{props.convId}</div>;
  },
}));

const { screen, waitFor } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { AdvisorCard } = await import('./AdvisorCard');
const { renderWithRouter } = await import('../test-helpers');

beforeEach(() => {
  advisorSessionMock.mockReset();
  chatPropsSpy.mockReset();
});

describe('AdvisorCard', () => {
  it('renders the starter questions and the input, no fetch on mount', () => {
    renderWithRouter(<AdvisorCard />);
    expect(screen.getAllByTestId('advisor-starter')).toHaveLength(3);
    expect(screen.getByTestId('advisor-input')).toBeInTheDocument();
    expect(advisorSessionMock).not.toHaveBeenCalled();
  });

  it('clicking a starter ensures the session and opens the chat with that question', async () => {
    const user = userEvent.setup();
    advisorSessionMock.mockResolvedValueOnce({ id: 'conv-1', agent_id: 'agent-1' });

    renderWithRouter(<AdvisorCard />);
    await user.click(screen.getByRole('button', { name: 'Review my setup' }));

    await waitFor(() => expect(screen.getByTestId('mock-session-chat')).toBeInTheDocument());
    expect(chatPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ convId: 'conv-1', initialMessage: 'Review my setup' }),
    );
    expect(screen.getByTestId('advisor-open-full')).toHaveAttribute('href', '/agents/agent-1');
  });

  it('submitting a typed question passes it as the initial message', async () => {
    const user = userEvent.setup();
    advisorSessionMock.mockResolvedValueOnce({ id: 'conv-2', agent_id: 'agent-1' });

    renderWithRouter(<AdvisorCard />);
    await user.type(screen.getByTestId('advisor-input'), 'Help me automate deploys');
    await user.click(screen.getByTestId('advisor-submit'));

    await waitFor(() => expect(screen.getByTestId('mock-session-chat')).toBeInTheDocument());
    expect(chatPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ convId: 'conv-2', initialMessage: 'Help me automate deploys' }),
    );
  });

  it('shows an error when the session fails to start', async () => {
    const user = userEvent.setup();
    advisorSessionMock.mockRejectedValueOnce(new Error('server down'));

    renderWithRouter(<AdvisorCard />);
    await user.click(screen.getByRole('button', { name: 'Review my setup' }));

    await waitFor(() => expect(screen.getByText(/server down/)).toBeInTheDocument());
    expect(screen.queryByTestId('mock-session-chat')).not.toBeInTheDocument();
  });
});
