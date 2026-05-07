import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { GlassPanel } from '@/components/ui/glass-panel';
import type { Task, WorkflowStatus } from '../../server/types';
import { timeAgo } from '@/lib/time';
import { repoName } from '@/lib/utils';

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
      className="group cursor-pointer rounded-xl transition-colors hover:bg-glass-l3"
      style={{
        opacity: isDragging ? 0.6 : 1,
        boxShadow: isDragging
          ? '0 16px 40px -8px rgba(0, 0, 0, 0.7)'
          : 'inset 0 1px 0 0 rgba(255, 255, 255, 0.12), 0 4px 12px -4px rgba(0, 0, 0, 0.45)',
      }}
    >
      <div className="px-3 py-2.5">
        {/* Error banner */}
        {task.runtime_state === 'error' && task.error && (
          <div
            className="mb-2 px-2 py-1 text-xs"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.08)' }}
          >
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
          className={`mt-0.5 truncate text-[11px] italic leading-tight ${
            isStale ? 'text-[#4a4a4a]' : 'text-[#8a8a8a]'
          }`}
        >
          {task.current_summary ?? '—'}
        </p>

        {/* Line 3: chips */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Badge
            variant="outline"
            className="border-[#2f2f2f] bg-[#141414] px-1.5 py-0 text-[10px] font-normal"
          >
            {repoName(task.repo_path)}
          </Badge>

          {/* External refs chips */}
          {task.external_refs?.map((ref) => (
            <a
              key={ref.integration}
              href={ref.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded border border-[#2f2f2f] bg-[#141414] px-1.5 py-0 text-[10px] text-[#8a8a8a] hover:text-foreground"
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
              className="inline-flex items-center rounded border border-[#3B82F666] bg-[#3B82F61F] px-1.5 py-0 text-[10px] font-medium text-[#3B82F6] hover:text-blue-400"
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
              <span className="text-[#6a6a6a]">
                {task.agents.length} agent{task.agents.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <span className="text-[10px] tabular-nums text-[#4a4a4a]">
            {timeAgo(task.updated_at)}
          </span>
        </div>
      </div>
    </GlassPanel>
  );
});
