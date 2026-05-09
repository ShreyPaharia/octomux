import { memo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { Task, WorkflowStatus } from '../../server/types';
import { BoardCard } from './BoardCard';
import { EmptyColumnPlaceholder } from './EmptyColumnPlaceholder';
import { DraggableBoardCard } from './DraggableBoardCard';

// ─── Column metadata ──────────────────────────────────────────────────────

interface ColumnDef {
  id: WorkflowStatus;
  label: string;
  accentClass: string;
  countClass: string;
  muted?: boolean;
}

export const COLUMN_DEFS: ColumnDef[] = [
  { id: 'backlog', label: 'Backlog', accentClass: 'text-[#8a8a8a]', countClass: 'text-[#4a4a4a]' },
  { id: 'planned', label: 'Planned', accentClass: 'text-[#8a8a8a]', countClass: 'text-[#4a4a4a]' },
  {
    id: 'in_progress',
    label: 'In progress',
    accentClass: 'text-[#3B82F6]',
    countClass: 'text-[#3B82F6]/60',
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
    accentClass: 'text-green-400',
    countClass: 'text-green-400/60',
  },
  {
    id: 'done',
    label: 'Done',
    accentClass: 'text-[#4a4a4a]',
    countClass: 'text-[#3a3a3a]',
  },
  {
    id: 'archived',
    label: 'Archived',
    accentClass: 'text-[#5a5a5a]',
    countClass: 'text-[#3a3a3a]',
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
    <div
      data-testid={`board-column-${column.id}`}
      className={`flex h-full w-[260px] flex-none flex-col${column.muted ? ' opacity-60' : ''}`}
    >
      {/* Column header */}
      <div
        className="mb-2 flex items-center justify-between px-1"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '8px' }}
      >
        <span className={`text-[11px] font-bold uppercase tracking-wider ${column.accentClass}`}>
          {column.label}
        </span>
        <div className="flex items-center gap-2">
          {column.id === 'done' && onArchiveDone && (
            <button
              type="button"
              data-testid="archive-all-done-btn"
              disabled={tasks.length === 0 || archiving}
              onClick={handleArchiveDone}
              className="text-[10px] text-[#6a6a6a] transition-colors hover:text-[#8a8a8a] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Archive all ({tasks.length})
            </button>
          )}
          <span className={`text-[11px] tabular-nums ${column.countClass}`}>{tasks.length}</span>
        </div>
      </div>

      {/* Droppable card list */}
      <div
        ref={setNodeRef}
        data-testid={`column-drop-${column.id}`}
        className="flex min-h-[80px] flex-1 flex-col gap-2 overflow-y-auto rounded-lg px-0.5 pb-2 transition-colors"
        style={{
          backgroundColor: isOver ? 'rgba(255,255,255,0.03)' : 'transparent',
        }}
      >
        {tasks.length === 0 ? (
          <EmptyColumnPlaceholder isOver={isOver} />
        ) : (
          tasks.map((task) => (
            <DraggableBoardCard key={task.id} task={task} isDragging={activeTaskId === task.id} />
          ))
        )}
      </div>
    </div>
  );
});

// Re-export ColumnDef and BoardCard for external use
export type { ColumnDef };
export { BoardCard };
