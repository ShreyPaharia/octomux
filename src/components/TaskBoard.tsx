import { useState, useCallback, useMemo } from 'react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { Task, WorkflowStatus } from '@octomux/types';
import { TaskBoardColumn, COLUMN_DEFS, type BoardColumnId } from './TaskBoardColumn';
import { MoveWithNoteDialog } from './MoveWithNoteDialog';
import { taskApi } from '@/lib/api/taskApi';
import { showToast } from './CustomToast';

// Columns that require a note when dragging into them
const NOTE_REQUIRED_COLUMNS = new Set<WorkflowStatus>(['planned', 'human_review']);

const SHOW_TRASH_KEY = 'octomux-board-show-trash';

// Default visible columns (trash excluded by default)
const DEFAULT_VISIBLE_COLUMNS = new Set<WorkflowStatus>([
  'backlog',
  'planned',
  'in_progress',
  'human_review',
  'pr',
  'done',
]);

interface PendingMove {
  taskId: string;
  taskTitle: string;
  targetColumn: WorkflowStatus;
}

interface TaskBoardProps {
  tasks: Task[];
  onTasksChange?: (tasks: Task[]) => void;
  graceHours?: number;
}

export function TaskBoard({ tasks, onTasksChange, graceHours = 6 }: TaskBoardProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // Optimistic override: maps task id → workflow_status override
  const [optimisticMoves, setOptimisticMoves] = useState<Map<string, WorkflowStatus>>(new Map());
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  // Show/hide trash column — default off, persisted to localStorage
  const [showTrash, setShowTrash] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_TRASH_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const toggleShowTrash = useCallback(() => {
    setShowTrash((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SHOW_TRASH_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Build task map with optimistic overrides applied
  const tasksWithOverrides = useMemo<Task[]>(() => {
    if (optimisticMoves.size === 0) return tasks;
    return tasks.map((t) => {
      const override = optimisticMoves.get(t.id);
      return override ? { ...t, workflow_status: override } : t;
    });
  }, [tasks, optimisticMoves]);

  // Group tasks by column — trashed tasks go to 'trash' regardless of workflow_status
  const columnTasks = useMemo<Record<BoardColumnId, Task[]>>(() => {
    const map: Record<BoardColumnId, Task[]> = {
      backlog: [],
      planned: [],
      in_progress: [],
      human_review: [],
      pr: [],
      done: [],
      trash: [],
    };
    for (const t of tasksWithOverrides) {
      if (t.deleted_at) {
        map.trash.push(t);
      } else if (t.workflow_status in map) {
        map[t.workflow_status].push(t);
      } else {
        map.backlog.push(t);
      }
    }
    return map;
  }, [tasksWithOverrides]);

  // Soft-delete all done tasks (moves them to trash)
  const handleDeleteDone = useCallback(async () => {
    try {
      const result = await taskApi.deleteDone();
      if (result.deleted > 0) {
        showToast(
          'success',
          `Deleted ${result.deleted} task${result.deleted === 1 ? '' : 's'}`,
          '',
        );
      }
    } catch (err: unknown) {
      showToast('error', 'Delete failed', (err as Error).message);
    }
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveTaskId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTaskId(null);
      const taskId = event.active.id as string;
      const targetColumn = event.over?.id as WorkflowStatus | undefined;

      if (!targetColumn) return;

      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      if (task.workflow_status === targetColumn) return;

      if (NOTE_REQUIRED_COLUMNS.has(targetColumn)) {
        // Show note prompt — hold off on move until confirmed
        setPendingMove({ taskId, taskTitle: task.title, targetColumn });
      } else {
        // Apply optimistic move immediately
        setOptimisticMoves((prev) => new Map(prev).set(taskId, targetColumn));
        taskApi
          .moveTask(taskId, { workflow_status: targetColumn })
          .then((updatedTask) => {
            // Clear optimistic when server responds; parent refresh handles the rest
            setOptimisticMoves((prev) => {
              const next = new Map(prev);
              next.delete(taskId);
              return next;
            });
            // Propagate to parent if provided
            if (onTasksChange) {
              onTasksChange(tasks.map((t) => (t.id === taskId ? updatedTask : t)));
            }
          })
          .catch((err: Error) => {
            // Revert optimistic move
            setOptimisticMoves((prev) => {
              const next = new Map(prev);
              next.delete(taskId);
              return next;
            });
            showToast('error', 'Move failed', err.message);
          });
      }
    },
    [tasks, onTasksChange],
  );

  const handleNoteConfirm = useCallback(
    (note: string) => {
      if (!pendingMove) return;
      const { taskId, targetColumn } = pendingMove;
      setPendingMove(null);

      // Apply optimistic
      setOptimisticMoves((prev) => new Map(prev).set(taskId, targetColumn));
      taskApi
        .moveTask(taskId, { workflow_status: targetColumn, note })
        .then((updatedTask) => {
          setOptimisticMoves((prev) => {
            const next = new Map(prev);
            next.delete(taskId);
            return next;
          });
          if (onTasksChange) {
            onTasksChange(tasks.map((t) => (t.id === taskId ? updatedTask : t)));
          }
        })
        .catch((err: Error) => {
          setOptimisticMoves((prev) => {
            const next = new Map(prev);
            next.delete(taskId);
            return next;
          });
          showToast('error', 'Move failed', err.message);
        });
    },
    [pendingMove, tasks, onTasksChange],
  );

  const handleNoteCancel = useCallback(() => {
    setPendingMove(null);
  }, []);

  // Determine which columns to render
  const visibleColumns = useMemo(() => {
    return COLUMN_DEFS.filter(
      (col) =>
        DEFAULT_VISIBLE_COLUMNS.has(col.id as WorkflowStatus) || (showTrash && col.id === 'trash'),
    );
  }, [showTrash]);

  return (
    <>
      <div className="mb-2 flex items-center justify-end px-1">
        <button
          type="button"
          data-testid="show-trash-toggle"
          onClick={toggleShowTrash}
          className={`text-[11px] transition-colors ${showTrash ? 'text-foreground' : 'text-[#6a6a6a] hover:text-[#8a8a8a]'}`}
        >
          {showTrash ? 'Hide trash' : 'Show trash'}
          {!showTrash && columnTasks['trash'].length > 0 && (
            <span className="ml-1 text-[#4a4a4a]">({columnTasks['trash'].length})</span>
          )}
        </button>
      </div>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div data-testid="task-board" className="flex h-full gap-4 overflow-x-auto px-1 pb-4">
          {visibleColumns.map((col) => (
            <TaskBoardColumn
              key={col.id}
              column={col}
              tasks={columnTasks[col.id]}
              activeTaskId={activeTaskId}
              onDeleteDone={col.id === 'done' ? handleDeleteDone : undefined}
              graceHours={graceHours}
            />
          ))}
        </div>
      </DndContext>

      {pendingMove && (
        <MoveWithNoteDialog
          open={true}
          targetColumn={pendingMove.targetColumn}
          taskTitle={pendingMove.taskTitle}
          onConfirm={handleNoteConfirm}
          onCancel={handleNoteCancel}
        />
      )}
    </>
  );
}
