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
import type { Task, WorkflowStatus } from '../../server/types';
import { TaskBoardColumn, COLUMN_DEFS } from './TaskBoardColumn';
import { MoveWithNoteDialog } from './MoveWithNoteDialog';
import { api } from '@/lib/api';
import { showToast } from './CustomToast';

// Columns that require a note when dragging into them
const NOTE_REQUIRED_COLUMNS = new Set<WorkflowStatus>(['planned', 'human_review']);

interface PendingMove {
  taskId: string;
  taskTitle: string;
  targetColumn: WorkflowStatus;
}

interface TaskBoardProps {
  tasks: Task[];
  onTasksChange?: (tasks: Task[]) => void;
}

export function TaskBoard({ tasks, onTasksChange }: TaskBoardProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // Optimistic override: maps task id → workflow_status override
  const [optimisticMoves, setOptimisticMoves] = useState<Map<string, WorkflowStatus>>(new Map());
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

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

  // Group tasks by column
  const columnTasks = useMemo<Record<WorkflowStatus, Task[]>>(() => {
    const map: Record<WorkflowStatus, Task[]> = {
      backlog: [],
      planned: [],
      in_progress: [],
      human_review: [],
      pr: [],
      done: [],
    };
    for (const t of tasksWithOverrides) {
      if (t.workflow_status in map) {
        map[t.workflow_status].push(t);
      } else {
        map['backlog'].push(t);
      }
    }
    return map;
  }, [tasksWithOverrides]);

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
        api
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
      api
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

  return (
    <>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div
          data-testid="task-board"
          className="flex h-full gap-4 overflow-x-auto px-1 pb-4"
        >
          {COLUMN_DEFS.map((col) => (
            <TaskBoardColumn
              key={col.id}
              column={col}
              tasks={columnTasks[col.id]}
              activeTaskId={activeTaskId}
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
