import type { Task } from '@octomux/types';
import { TaskCard } from './TaskCard';
import { EmptyState } from './EmptyState';
import { TerminalRectIcon } from './icons';

interface TaskListProps {
  tasks: Task[];
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
  onResume?: (id: string) => void;
  totalCount?: number;
  emptyAction?: React.ReactNode;
}

export function TaskList({
  tasks,
  onClose,
  onDelete,
  onResume,
  totalCount = 0,
  emptyAction,
}: TaskListProps) {
  if (tasks.length === 0) {
    const isFiltered = totalCount > 0;
    return isFiltered ? (
      <EmptyState
        icon={
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
            <path d="M8 11h6" />
          </svg>
        }
        heading="No matching tasks"
        subtext="Try adjusting your filters or status tab"
      />
    ) : (
      <EmptyState
        icon={<TerminalRectIcon />}
        heading="No tasks yet"
        subtext="Create your first task to start running agents"
        action={emptyAction}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          onClose={onClose}
          onDelete={onDelete}
          onResume={onResume}
        />
      ))}
    </div>
  );
}
