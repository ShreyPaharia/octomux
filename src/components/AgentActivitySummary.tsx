import { memo } from 'react';
import type { Agent, PermissionPrompt } from '../../server/types';
import { timeAgo, timeSince } from '@/lib/time';

interface AgentActivitySummaryProps {
  agents: Agent[];
  pendingPrompts?: PermissionPrompt[];
  /** Compact mode for table rows — single line, no wrapping */
  compact?: boolean;
}

const ACTIVITY_DOT: Record<string, string> = {
  active: 'bg-green-500',
  idle: 'bg-zinc-400',
  waiting: 'bg-amber-500',
};

function agentStatusText(agent: Agent): string {
  if (agent.hook_activity === 'active') return 'Active';
  if (agent.hook_activity === 'waiting') return 'Waiting for input';
  // idle — show duration
  if (agent.hook_activity_updated_at) {
    return `Idle ${timeSince(agent.hook_activity_updated_at)}`;
  }
  return 'Idle';
}

function mostRecentActivity(agents: Agent[]): string | null {
  let latest: string | null = null;
  for (const a of agents) {
    if (a.hook_activity_updated_at && (!latest || a.hook_activity_updated_at > latest)) {
      latest = a.hook_activity_updated_at;
    }
  }
  return latest;
}

export const AgentActivitySummary = memo(function AgentActivitySummary({
  agents,
  pendingPrompts,
  compact,
}: AgentActivitySummaryProps) {
  const activeAgents = agents.filter((a) => a.status !== 'stopped');
  const hasPendingPrompts = pendingPrompts && pendingPrompts.length > 0;
  const lastActivity = mostRecentActivity(activeAgents);

  if (activeAgents.length === 0) return null;

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <span className="tabular-nums text-xs text-muted-foreground">
          {activeAgents.length} agent{activeAgents.length > 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-1">
          {activeAgents.map((a) => (
            <span
              key={a.id}
              title={`${a.label}: ${agentStatusText(a)}`}
              className={`inline-block h-2 w-2 rounded-full ${ACTIVITY_DOT[a.hook_activity] || ACTIVITY_DOT.active} ${a.hook_activity === 'active' ? 'animate-pulse' : ''}`}
            />
          ))}
        </div>
        {hasPendingPrompts && (
          <span className="inline-flex items-center gap-0.5 text-amber-500" title="Needs input">
            <span className="animate-pulse text-xs">&#x26A0;</span>
            <span className="text-[10px] font-semibold uppercase">{pendingPrompts.length}</span>
          </span>
        )}
        {lastActivity && (
          <span className="text-xs text-muted-foreground">{timeAgo(lastActivity)}</span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {/* Header: agent count + last active */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {activeAgents.length} agent{activeAgents.length > 1 ? 's' : ''}
        </span>
        {lastActivity && (
          <>
            <span className="text-zinc-600">&middot;</span>
            <span className="tabular-nums">Last active {timeAgo(lastActivity)}</span>
          </>
        )}
        {hasPendingPrompts && (
          <span className="ml-auto inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
            <span className="animate-pulse">&#x26A0;</span>
            Needs input
          </span>
        )}
      </div>
      {/* Per-agent activity */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {activeAgents.map((a) => (
          <span key={a.id} className="inline-flex items-center gap-1">
            <span
              className={`inline-block h-2 w-2 rounded-full ${ACTIVITY_DOT[a.hook_activity] || ACTIVITY_DOT.active} ${a.hook_activity === 'active' ? 'animate-pulse' : ''}`}
            />
            <span className="text-zinc-400">{agentStatusText(a)}</span>
            <span className="text-zinc-500">{a.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
});
