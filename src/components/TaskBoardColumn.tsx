import { memo } from 'react';
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
];

interface TaskBoardColumnProps {
  column: ColumnDef;
  tasks: Task[];
  activeTaskId: string | null;
}

export const TaskBoardColumn = memo(function TaskBoardColumn({
  column,
  tasks,
  activeTaskId,
}: TaskBoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div
      data-testid={`board-column-${column.id}`}
      className="flex h-full w-[260px] flex-none flex-col"
    >
      {/* Column header */}
      <div
        className="mb-2 flex items-center justify-between px-1"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '8px' }}
      >
        <span className={`text-[11px] font-bold uppercase tracking-wider ${column.accentClass}`}>
          {column.label}
        </span>
        <span className={`text-[11px] tabular-nums ${column.countClass}`}>{tasks.length}</span>
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
