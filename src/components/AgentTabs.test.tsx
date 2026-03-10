import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentTabs } from './AgentTabs';
import { renderWithRouter } from '../test-helpers';
import type { Agent } from '../../server/types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-01',
    task_id: 'task-01',
    window_index: 0,
    label: 'Agent 1',
    status: 'running',
    claude_session_id: null,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('AgentTabs', () => {
  const onSelect = vi.fn();
  const onAddAgent = vi.fn();
  const onStopAgent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultProps = {
    activeIndex: 0,
    onSelect,
    onAddAgent,
    onStopAgent,
    canAddAgent: true,
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
    expect(screen.getByText('+')).toBeInTheDocument();
  });

  it('hides add button when canAddAgent is false', () => {
    renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} canAddAgent={false} />);
    expect(screen.queryByText('+')).not.toBeInTheDocument();
  });

  it('calls onAddAgent without prompt on quick add', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} />);

    await user.click(screen.getByText('+'));
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
});
