import { memo, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { GlassPanel } from '@/components/ui/glass-panel';
import type { Task, WorkflowStatus } from '@octomux/types';
import { timeAgo } from '@/lib/time';
import { formatDuration } from '@/lib/format-duration';
import { cn, repoName } from '@/lib/utils';
import { taskApi } from '@/lib/api/taskApi';
import { TrashCountdown } from './TrashCountdown';
import { clearDiffTreeExpandedState } from '@/lib/diff-tree-storage';

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

// ─── Live duration label ──────────────────────────────────────────────────

/**
 * Shows time since the task started. Ticks every second while the task is
 * active (running / setting_up); shows the final, static duration for
 * terminal states (idle = closed, error).
 */
function TaskDuration({ task }: { task: Task }) {
  const isActive = task.runtime_state === 'running' || task.runtime_state === 'setting_up';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [isActive]);

  const start = new Date(task.created_at + 'Z').getTime();
  if (Number.isNaN(start)) return null;

  const end = isActive ? now : new Date(task.updated_at + 'Z').getTime();
  const label = formatDuration(end - start);

  const prefix =
    task.runtime_state === 'running'
      ? 'Running'
      : task.runtime_state === 'setting_up'
        ? 'Setting up'
        : task.runtime_state === 'error'
          ? 'Failed after'
          : 'Closed after';

  return (
    <span data-testid="task-duration" className="text-[10px] tabular-nums text-muted-soft">
      {prefix} {label}
    </span>
  );
}

interface BoardCardProps {
  task: Task;
  isDragging?: boolean;
  workflowStatus?: WorkflowStatus;
  graceHours?: number;
}

export const BoardCard = memo(function BoardCard({
  task,
  isDragging,
  graceHours = 6,
}: BoardCardProps) {
  const navigate = useNavigate();
  const isStale =
    task.runtime_state === 'running' &&
    (!task.current_summary_updated_at ||
      Date.now() - new Date(task.current_summary_updated_at + 'Z').getTime() > 3_600_000);

  const isTrashed = task.deleted_at !== null;

  const handleClick = () => {
    if (isTrashed) return; // don't navigate to trashed tasks
    navigate(`/tasks/${task.id}`);
  };

  const handleRestore = (e: React.MouseEvent) => {
    e.stopPropagation();
    taskApi.restoreTask(task.id).catch(() => {
      // WS refresh will re-render; swallow error silently
    });
  };

  const handlePurge = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Permanently delete "${task.title}"? This cannot be undone.`)) return;
    taskApi.deleteTask(task.id, { purge: true }).catch(() => {
      // swallow
    });
    clearDiffTreeExpandedState(task.id);
  };

  return (
    <GlassPanel
      level={2}
      specular
      onClick={handleClick}
      data-testid="board-card"
      data-task-id={task.id}
      className={cn(
        'group rounded-xl transition-all duration-150',
        isTrashed ? 'cursor-default' : 'cursor-pointer hover:bg-glass-l3/50',
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
            <TaskDuration task={task} />
          </div>
          <span className="text-[10px] tabular-nums text-muted-soft">
            {timeAgo(task.updated_at)}
          </span>
        </div>

        {/* Trash footer: countdown + restore/delete-now actions */}
        {isTrashed && (
          <div className="mt-2 border-t border-glass-edge pt-2">
            <div className="flex items-center justify-between gap-2">
              <TrashCountdown deletedAt={task.deleted_at!} graceHours={graceHours} />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="trash-restore-btn"
                  onClick={handleRestore}
                  className="focus-ring rounded text-[10px] text-primary transition-colors hover:text-primary/80"
                >
                  Restore
                </button>
                <button
                  type="button"
                  data-testid="trash-delete-now-btn"
                  onClick={handlePurge}
                  className="focus-ring rounded text-[10px] text-destructive transition-colors hover:text-destructive/80"
                >
                  Delete now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </GlassPanel>
  );
});
