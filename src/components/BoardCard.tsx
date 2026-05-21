import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { GlassPanel } from '@/components/ui/glass-panel';
import type { Task, WorkflowStatus } from '../../server/types';
import { timeAgo } from '@/lib/time';
import { cn, repoName } from '@/lib/utils';

// ─── Runtime indicator glyphs ─────────────────────────────────────────────

function RuntimeDot({ state }: { state: Task['runtime_state'] }) {
  switch (state) {
    case 'running':
      return <span className="text-green-400">●</span>;
    case 'setting_up':
      return <span className="text-yellow-400">◐</span>;
    case 'error':
      return <span className="text-red-400">▲</span>;
    case 'idle':
    default:
      return <span className="text-[#4a4a4a]">○</span>;
  }
}

interface BoardCardProps {
  task: Task;
  isDragging?: boolean;
  workflowStatus?: WorkflowStatus;
}

export const BoardCard = memo(function BoardCard({ task, isDragging }: BoardCardProps) {
  const navigate = useNavigate();
  const isStale =
    task.runtime_state === 'running' &&
    (!task.current_summary_updated_at ||
      Date.now() - new Date(task.current_summary_updated_at + 'Z').getTime() > 3_600_000);

  const handleClick = () => {
    navigate(`/tasks/${task.id}`);
  };

  return (
    <GlassPanel
      level={2}
      specular
      onClick={handleClick}
      data-testid="board-card"
      data-task-id={task.id}
      className={cn(
        'group cursor-pointer rounded-xl transition-all duration-150 hover:bg-glass-l3/50',
        isDragging && 'opacity-60 shadow-[0_16px_40px_-8px_rgba(0,0,0,0.7)]',
      )}
    >
      <div className="px-3 py-2.5">
        {/* Error banner */}
        {task.runtime_state === 'error' && task.error && (
          <div className="mb-2 rounded-md bg-destructive/10 px-2 py-1 text-xs">
            <span className="font-bold text-red-500">Error:</span>{' '}
            <span className="truncate text-red-400">{task.error}</span>
          </div>
        )}

        {/* Line 1: title */}
        <h3
          title={task.title}
          className="truncate text-[13px] font-semibold leading-snug text-foreground"
        >
          {task.title}
        </h3>

        {/* Line 2: current_summary */}
        <p
          className={cn(
            'mt-0.5 truncate text-[11px] italic leading-tight',
            isStale ? 'text-muted-soft' : 'text-muted-foreground',
          )}
        >
          {task.current_summary ?? '—'}
        </p>

        {/* Line 3: chips */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
            {repoName(task.repo_path)}
          </Badge>

          {/* External refs chips */}
          {task.external_refs?.map((ref) => (
            <a
              key={ref.integration}
              href={ref.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-md border border-input bg-secondary px-1.5 py-0 text-[10px] text-muted-soft hover:text-foreground"
              onClick={ref.url ? (e) => e.stopPropagation() : (e) => e.preventDefault()}
            >
              {ref.integration}:{ref.ref}
            </a>
          ))}

          {/* PR badge */}
          {task.pr_url && (
            <a
              href={task.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-medium text-primary hover:text-primary/80"
              onClick={(e) => e.stopPropagation()}
            >
              PR #{task.pr_number}
            </a>
          )}
        </div>

        {/* Footer: runtime indicator + timestamp */}
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px]">
            <RuntimeDot state={task.runtime_state} />
            {task.runtime_state === 'running' && task.agents && task.agents.length > 0 && (
              <span className="text-muted-soft">
                {task.agents.length} agent{task.agents.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <span className="text-[10px] tabular-nums text-muted-soft">
            {timeAgo(task.updated_at)}
          </span>
        </div>
      </div>
    </GlassPanel>
  );
});
