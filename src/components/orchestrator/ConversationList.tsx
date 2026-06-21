/**
 * src/components/orchestrator/ConversationList.tsx
 *
 * Multi-conversation management sidebar for the orchestrator chat (Task 5.1 / SHR-136).
 *
 * Features:
 *  - Lists all conversations ordered by most-recently-updated.
 *  - Highlights the active conversation.
 *  - "New conversation" button to create a conversation.
 *  - Per-conversation "Monitor" toggle button to designate the conversation as the
 *    global-monitor (receives read-only notices for tasks not owned by any conversation).
 *    Only one conversation can be the global-monitor at a time; the indicator is shown
 *    on the currently-designated conversation.
 *
 * Global-monitor mode (spec §6, SHR-136):
 *   When a conversation is designated as global-monitor, the supervisor routes
 *   events for unowned tasks to it as read-only notices (prefixed with [monitor]).
 *   These notices never trigger auto-actions. The designation is toggled via the
 *   "Monitor" button and persisted server-side via PATCH /api/orchestrator/conversations/:id/global-monitor.
 */

import type { OrchestratorConversation } from '../../lib/orchestrator-api';
import { cn } from '@/lib/utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationListProps {
  conversations: OrchestratorConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Called when the user clicks the monitor toggle on a conversation. */
  onToggleMonitor: (id: string) => void;
  loading: boolean;
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <line
        x1="7"
        y1="1"
        x2="7"
        y2="13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="1"
        y1="7"
        x2="13"
        y2="7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Eye icon to indicate/toggle global-monitor mode. */
function MonitorIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? '#7c9cff' : 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// ─── ConversationList ─────────────────────────────────────────────────────────

/**
 * Sidebar listing all orchestrator conversations with:
 *  - active highlight
 *  - per-row global-monitor toggle button
 *  - "new conversation" header button
 */
export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onToggleMonitor,
  loading,
}: ConversationListProps) {
  return (
    <div className="flex h-full flex-col bg-[#0e1116]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.45)]">
          Conversations
        </span>
        <button
          type="button"
          onClick={onNew}
          aria-label="New conversation"
          title="New conversation"
          data-testid="new-conversation-btn"
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-[rgba(255,255,255,0.55)] hover:text-white',
            FOCUS_RING,
          )}
        >
          <PlusIcon />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2">
        {loading && (
          <div className="px-4 py-2 text-xs text-[rgba(255,255,255,0.35)]">Loading...</div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="px-4 py-2 text-xs text-[rgba(255,255,255,0.35)]">
            No conversations yet.
          </div>
        )}
        {conversations.map((conv) => {
          const isActive = conv.id === activeId;
          const isMonitor = Boolean(conv.is_global_monitor);

          return (
            <div key={conv.id} className="group relative mx-2 my-0.5 flex items-center gap-1">
              {/* Conversation row button */}
              <button
                type="button"
                onClick={() => onSelect(conv.id)}
                aria-current={isActive ? 'true' : undefined}
                data-testid={`conv-row-${conv.id}`}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-lg px-3 py-2 text-left text-xs transition-colors',
                  isActive
                    ? 'bg-[rgba(59,130,246,0.14)] font-semibold text-[#3B82F6]'
                    : 'text-[rgba(255,255,255,0.65)] hover:bg-[rgba(255,255,255,0.04)] hover:text-white',
                  FOCUS_RING,
                )}
              >
                {/* Global-monitor indicator dot */}
                {isMonitor && (
                  <span
                    data-testid={`global-monitor-indicator-${conv.id}`}
                    aria-label="Global monitor"
                    title="Global monitor — receives notices for all unowned tasks"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#7c9cff]"
                  />
                )}
                <span className="truncate">{conv.title}</span>
              </button>

              {/* Monitor toggle button — visible on hover or when active */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleMonitor(conv.id);
                }}
                aria-label={isMonitor ? 'Disable global monitor' : 'Enable global monitor'}
                title={
                  isMonitor
                    ? 'Disable global monitor mode'
                    : 'Enable global monitor mode — receive notices for all tasks'
                }
                data-testid={`toggle-monitor-${conv.id}`}
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
                  isMonitor
                    ? 'text-[#7c9cff] opacity-100'
                    : 'text-[rgba(255,255,255,0.25)] opacity-0 group-hover:opacity-100',
                  'hover:bg-[rgba(255,255,255,0.06)]',
                  FOCUS_RING,
                )}
              >
                <MonitorIcon active={isMonitor} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
