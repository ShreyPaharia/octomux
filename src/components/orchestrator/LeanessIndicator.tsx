import { cn } from '@/lib/utils';
import type { ConversationUsage } from '@/lib/orchestrator-api';

/**
 * Conductor-leanness indicator (§6.7).
 *
 * Surfaces orchestrator-vs-worker activity so the user can tell if the
 * conductor is accumulating context that should be delegated. Shows:
 *  - tasks spawned
 *  - tool calls made
 *
 * Turns orange/warning when tasks_spawned >= 12 or tool_calls >= 40
 * (spec §10: soft threshold = "12 tasks spawned or M minutes").
 * These are configurable thresholds; off-by-default in the UI
 * (only shown when a conversation is open).
 */
export interface LeanessIndicatorProps {
  usage: ConversationUsage;
}

export function LeanessIndicator({ usage }: LeanessIndicatorProps) {
  const TASKS_WARN = 12;
  const CALLS_WARN = 40;
  const isWarning = usage.tasks_spawned >= TASKS_WARN || usage.tool_calls >= CALLS_WARN;

  return (
    <div
      aria-label="Conductor leanness stats"
      title={`Conductor activity: ${usage.tasks_spawned} tasks spawned, ${usage.tool_calls} tool calls`}
      className={cn(
        'ml-auto flex items-center gap-2 rounded-md px-2 py-1 text-xs tabular-nums',
        isWarning
          ? 'bg-[rgba(251,146,60,0.12)] text-[#FB923C]'
          : 'bg-[rgba(255,255,255,0.04)] text-[rgba(255,255,255,0.45)]',
      )}
    >
      {isWarning && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M6 1L1 11h10L6 1zm0 2l3.5 7h-7L6 3zm-.5 3v2h1V6h-1zm0 3v1h1V9h-1z" />
        </svg>
      )}
      <span>{usage.tasks_spawned} tasks</span>
      <span aria-hidden="true">·</span>
      <span>{usage.tool_calls} calls</span>
    </div>
  );
}
