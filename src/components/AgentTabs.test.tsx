import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentTabs } from './AgentTabs';
import { renderWithRouter, makeAgent } from '../test-helpers';
import type { UserTerminal } from '../../server/types';

function makeUserTerminal(overrides: Partial<UserTerminal> = {}): UserTerminal {
  return {
    id: 'term-1',
    task_id: 'test-task-01',
    window_index: 2,
    label: 'Terminal 1',
    status: 'idle' as const,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('AgentTabs', () => {
  const onSelect = vi.fn();
  const onAddAgent = vi.fn();
  const onStopAgent = vi.fn();
  const onAddTerminal = vi.fn();
  const onCloseTerminal = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultProps = {
    activeIndex: 0,
    onSelect,
    onAddAgent,
    onStopAgent,
    canAddAgent: true,
    userTerminals: [] as UserTerminal[],
    onAddTerminal,
    onCloseTerminal,
  };

  // ─── Rendering agents ─────────────────────────────────────────────────────

  it('renders agent labels', () => {
    const agents = [makeAgent(), makeAgent({ id: 'a2', window_index: 1, label: 'Agent 2' })];
    renderWithRouter(<AgentTabs {...defaultProps} agents={agents} />);
    expect(screen.getByText('Agent 1')).toBeInTheDocument();
    expect(screen.getByText('Agent 2')).toBeInTheDocument();
  });

  it('shows pulse indicator for running agents', () => {
    const agents = [makeAgent()];
    const { container } = renderWithRouter(<AgentTabs {...defaultProps} agents={agents} />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('does not show pulse indicator for stopped agents', () => {
    const agents = [makeAgent({ status: 'stopped' })];
    const { container } = renderWithRouter(<AgentTabs {...defaultProps} agents={agents} />);
    expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument();
  });

  // ─── Selection ────────────────────────────────────────────────────────────

  it('calls onSelect when clicking an agent tab', async () => {
    const user = userEvent.setup();
    const agents = [makeAgent(), makeAgent({ id: 'a2', window_index: 1, label: 'Agent 2' })];
    renderWithRouter(<AgentTabs {...defaultProps} agents={agents} />);

    await user.click(screen.getByText('Agent 2'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  // ─── Add agent ────────────────────────────────────────────────────────────

  it('shows add button when canAddAgent is true', () => {
    renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} />);
    expect(screen.getByTitle('Add agent without prompt')).toBeInTheDocument();
  });

  it('hides add button when canAddAgent is false', () => {
    renderWithRouter(
      <AgentTabs
        {...defaultProps}
        agents={[makeAgent()]}
        canAddAgent={false}
        onAddTerminal={undefined}
      />,
    );
    expect(screen.queryByTitle('Add agent without prompt')).not.toBeInTheDocument();
  });

  it('calls onAddAgent without prompt on quick add', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} />);

    await user.click(screen.getByTitle('Add agent without prompt'));
    expect(onAddAgent).toHaveBeenCalledWith();
  });

  // ─── Multiple agents with different statuses (table-driven) ───────────────

  const visibleStatusCases = [{ status: 'running' as const }, { status: 'idle' as const }];

  it.each(visibleStatusCases)('agent with status "$status" is visible', ({ status }) => {
    const agents = [makeAgent({ status })];
    renderWithRouter(<AgentTabs {...defaultProps} agents={agents} />);
    expect(screen.getByText('Agent 1')).toBeInTheDocument();
  });

  it('hides stopped agents', () => {
    const agents = [makeAgent({ status: 'stopped' })];
    renderWithRouter(<AgentTabs {...defaultProps} agents={agents} />);
    expect(screen.queryByText('Agent 1')).not.toBeInTheDocument();
  });

  // ─── Terminal tabs ─────────────────────────────────────────────────────────

  describe('Terminal tabs', () => {
    it('renders terminal labels', () => {
      const terminals = [makeUserTerminal()];
      renderWithRouter(
        <AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />,
      );
      expect(screen.getByText('Terminal 1')).toBeInTheDocument();
    });

    it('renders separator between groups', () => {
      const terminals = [makeUserTerminal()];
      renderWithRouter(
        <AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />,
      );
      expect(screen.getByTestId('tab-separator')).toBeInTheDocument();
    });

    it('calls onSelect when clicking terminal tab', async () => {
      const user = userEvent.setup();
      const terminals = [makeUserTerminal({ window_index: 2 })];
      renderWithRouter(
        <AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />,
      );
      await user.click(screen.getByText('Terminal 1'));
      expect(onSelect).toHaveBeenCalledWith(2);
    });

    it('calls onCloseTerminal when clicking close button', async () => {
      const user = userEvent.setup();
      const terminals = [makeUserTerminal({ id: 'term-1' })];
      renderWithRouter(
        <AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />,
      );
      await user.click(screen.getByTitle('Close terminal'));
      expect(onCloseTerminal).toHaveBeenCalledWith('term-1');
    });

    it('calls onAddTerminal when clicking terminal + button', async () => {
      const user = userEvent.setup();
      renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={[]} />);
      await user.click(screen.getByTitle('Add terminal'));
      expect(onAddTerminal).toHaveBeenCalled();
    });

    it('shows working indicator for working terminals', () => {
      const terminals = [makeUserTerminal({ status: 'working' })];
      const { container } = renderWithRouter(
        <AgentTabs {...defaultProps} agents={[]} userTerminals={terminals} />,
      );
      // Filter out agent pulse indicators — find the terminal status dot
      const dots = container.querySelectorAll('.animate-pulse');
      expect(dots.length).toBeGreaterThan(0);
    });

    it('shows idle indicator for idle terminals', () => {
      const terminals = [makeUserTerminal({ status: 'idle' })];
      const { container } = renderWithRouter(
        <AgentTabs {...defaultProps} agents={[]} userTerminals={terminals} />,
      );
      expect(container.querySelector('.bg-zinc-400')).toBeInTheDocument();
    });
  });
});
