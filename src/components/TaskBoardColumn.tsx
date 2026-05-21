import { memo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { Task, WorkflowStatus } from '../../server/types';
import { GlassPanel } from '@/components/ui/glass-panel';
import { BoardCard } from './BoardCard';
import { EmptyColumnPlaceholder } from './EmptyColumnPlaceholder';
import { DraggableBoardCard } from './DraggableBoardCard';
import { cn } from '@/lib/utils';

interface ColumnDef {
  id: WorkflowStatus;
  label: string;
  accentClass: string;
  countClass: string;
  muted?: boolean;
}

export const COLUMN_DEFS: ColumnDef[] = [
  {
    id: 'backlog',
    label: 'Backlog',
    accentClass: 'text-muted-soft',
    countClass: 'text-muted-soft',
  },
  {
    id: 'planned',
    label: 'Planned',
    accentClass: 'text-muted-soft',
    countClass: 'text-muted-soft',
  },
  {
    id: 'in_progress',
    label: 'In progress',
    accentClass: 'text-primary',
    countClass: 'text-primary/60',
  },
  {
    id: 'human_review',
    label: 'Human review',
    accentClass: 'text-amber-400',
    countClass: 'text-amber-400/60',
  },
  {
    id: 'pr',
    label: 'PR',
    accentClass: 'text-success',
    countClass: 'text-success/60',
  },
  {
    id: 'done',
    label: 'Done',
    accentClass: 'text-muted-soft',
    countClass: 'text-muted-soft/80',
  },
  {
    id: 'archived',
    label: 'Archived',
    accentClass: 'text-muted-soft/80',
    countClass: 'text-muted-soft/60',
    muted: true,
  },
];

interface TaskBoardColumnProps {
  column: ColumnDef;
  tasks: Task[];
  activeTaskId: string | null;
  onArchiveDone?: () => void;
}

export const TaskBoardColumn = memo(function TaskBoardColumn({
  column,
  tasks,
  activeTaskId,
  onArchiveDone,
}: TaskBoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const [archiving, setArchiving] = useState(false);

  const handleArchiveDone = async () => {
    if (!onArchiveDone || tasks.length === 0) return;
    setArchiving(true);
    try {
      onArchiveDone();
    } finally {
      setArchiving(false);
    }
  };

  return (
    <GlassPanel
      level={1}
      data-testid={`board-column-${column.id}`}
      className={cn(
        'flex h-full w-[260px] flex-none flex-col rounded-2xl p-2',
        column.muted && 'opacity-60',
      )}
    >
      <div className="mb-2 flex items-center justify-between border-b border-glass-edge px-1 pb-2">
        <span className={cn('text-xs font-semibold', column.accentClass)}>{column.label}</span>
        <div className="flex items-center gap-2">
          {column.id === 'done' && onArchiveDone && (
            <button
              type="button"
              data-testid="archive-all-done-btn"
              disabled={tasks.length === 0 || archiving}
              onClick={handleArchiveDone}
              className="focus-ring rounded text-[10px] text-muted-soft transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              Archive all ({tasks.length})
            </button>
          )}
          <span className={cn('text-xs tabular-nums', column.countClass)}>{tasks.length}</span>
        </div>
      </div>

      <div
        ref={setNodeRef}
        data-testid={`column-drop-${column.id}`}
        className={cn(
          'board-column-drop flex min-h-[80px] flex-1 flex-col gap-2 overflow-y-auto px-0.5 pb-2',
          isOver && 'bg-glass-l2/30',
        )}
      >
        {tasks.length === 0 ? (
          <EmptyColumnPlaceholder isOver={isOver} />
        ) : (
          tasks.map((task) => (
            <DraggableBoardCard key={task.id} task={task} isDragging={activeTaskId === task.id} />
          ))
        )}
      </div>
    </GlassPanel>
  );
});

export type { ColumnDef };
export { BoardCard };
