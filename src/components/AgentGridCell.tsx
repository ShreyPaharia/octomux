import { memo } from 'react';
import { TerminalView } from './TerminalView';
import { AgentActivityDot } from './AgentActivityDot';
import type { HookActivity } from '../../server/types';

export interface AgentGridCellProps {
  taskId: string;
  windowIndex: number;
  taskTitle: string;
  agentName: string;
  activity: HookActivity;
}

export const AgentGridCell = memo(function AgentGridCell({
  taskId,
  windowIndex,
  taskTitle,
  agentName,
  activity,
}: AgentGridCellProps) {
  return (
    <div
      data-testid={`agent-grid-cell-${taskId}-${windowIndex}`}
      className="flex aspect-video min-h-0 flex-col overflow-hidden rounded-lg border border-glass-edge bg-[#09090b]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-glass-edge px-2 py-1 text-[11px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground" title={taskTitle}>
            {taskTitle}
          </span>
          <span className="shrink-0 text-muted-foreground">·</span>
          <span className="shrink-0 truncate text-muted-foreground" title={agentName}>
            {agentName}
          </span>
        </div>
        <AgentActivityDot activity={activity} />
      </div>
      <div className="min-h-0 flex-1">
        <TerminalView
          taskId={taskId}
          windowIndex={windowIndex}
          readOnly
          fontSize={10}
          scrollback={500}
        />
      </div>
    </div>
  );
});
