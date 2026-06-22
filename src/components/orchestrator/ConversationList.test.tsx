/**
 * src/components/orchestrator/ConversationList.test.tsx
 *
 * Tests for the ConversationList component (Task 5.1 / SHR-136):
 *  - Renders a list of conversations with title and active state.
 *  - "New conversation" button calls onNew.
 *  - Clicking a conversation calls onSelect with that id.
 *  - Global-monitor toggle: clicking "Monitor" on a conversation calls onToggleMonitor.
 *  - Conversation marked as global-monitor shows an indicator.
 *  - Loading state renders a loading message.
 *  - Empty state renders a placeholder.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { ConversationList } from './ConversationList';
import { renderWithRouter } from '../../test-helpers';
import type { OrchestratorConversation } from '../../lib/orchestrator-api';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeConv(overrides: Partial<OrchestratorConversation> = {}): OrchestratorConversation {
  return {
    id: 'conv-abc',
    title: 'Test Conversation',
    status: 'active',
    tmux_window: null,
    claude_session_id: null,
    transcript_path: null,
    created_at: '2026-06-20 00:00:00',
    updated_at: '2026-06-20 00:00:00',
    is_global_monitor: 0,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationList', () => {
  it('renders a list of conversations with titles', () => {
    const convs = [
      makeConv({ id: 'c1', title: 'First Chat' }),
      makeConv({ id: 'c2', title: 'Second Chat' }),
    ];
    renderWithRouter(
      <ConversationList
        conversations={convs}
        activeId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onToggleMonitor={vi.fn()}
        loading={false}
      />,
    );
    expect(screen.getByText('First Chat')).toBeInTheDocument();
    expect(screen.getByText('Second Chat')).toBeInTheDocument();
  });

  it('highlights the active conversation', () => {
    const convs = [
      makeConv({ id: 'c1', title: 'Active One' }),
      makeConv({ id: 'c2', title: 'Inactive One' }),
    ];
    renderWithRouter(
      <ConversationList
        conversations={convs}
        activeId="c1"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onToggleMonitor={vi.fn()}
        loading={false}
      />,
    );
    const activeBtn = screen.getByTestId('conv-row-c1');
    expect(activeBtn).toHaveAttribute('aria-current', 'true');
    const inactiveBtn = screen.getByTestId('conv-row-c2');
    expect(inactiveBtn).not.toHaveAttribute('aria-current');
  });

  it('calls onSelect when a conversation is clicked', () => {
    const onSelect = vi.fn();
    const convs = [makeConv({ id: 'c1', title: 'Click Me' })];
    renderWithRouter(
      <ConversationList
        conversations={convs}
        activeId={null}
        onSelect={onSelect}
        onNew={vi.fn()}
        onToggleMonitor={vi.fn()}
        loading={false}
      />,
    );
    fireEvent.click(screen.getByText('Click Me'));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('calls onNew when the new conversation button is clicked', () => {
    const onNew = vi.fn();
    renderWithRouter(
      <ConversationList
        conversations={[]}
        activeId={null}
        onSelect={vi.fn()}
        onNew={onNew}
        onToggleMonitor={vi.fn()}
        loading={false}
      />,
    );
    fireEvent.click(screen.getByTestId('new-conversation-btn'));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('renders loading state', () => {
    renderWithRouter(
      <ConversationList
        conversations={[]}
        activeId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onToggleMonitor={vi.fn()}
        loading={true}
      />,
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders empty state when no conversations', () => {
    renderWithRouter(
      <ConversationList
        conversations={[]}
        activeId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onToggleMonitor={vi.fn()}
        loading={false}
      />,
    );
    expect(screen.getByText(/no conversations/i)).toBeInTheDocument();
  });

  it('shows a monitor indicator on global-monitor conversation', () => {
    const convs = [makeConv({ id: 'c1', title: 'Monitor Conv', is_global_monitor: 1 })];
    renderWithRouter(
      <ConversationList
        conversations={convs}
        activeId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onToggleMonitor={vi.fn()}
        loading={false}
      />,
    );
    // The global-monitor indicator should be present
    expect(screen.getByTestId('global-monitor-indicator-c1')).toBeInTheDocument();
  });

  it('calls onToggleMonitor when the monitor toggle button is clicked', () => {
    const onToggleMonitor = vi.fn();
    const convs = [makeConv({ id: 'c1', title: 'Monitor Conv' })];
    renderWithRouter(
      <ConversationList
        conversations={convs}
        activeId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onToggleMonitor={onToggleMonitor}
        loading={false}
      />,
    );
    fireEvent.click(screen.getByTestId('toggle-monitor-c1'));
    expect(onToggleMonitor).toHaveBeenCalledWith('c1');
  });
});
