import type { Task } from '../../server/types';
import { TaskCard } from './TaskCard';

interface TaskListProps {
  tasks: Task[];
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
  onResume?: (id: string) => void;
}

export function TaskList({ tasks, onClose, onDelete, onResume }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-lg">No tasks yet</p>
        <p className="text-sm">Create a task to get started</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
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
