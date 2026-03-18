import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '../../server/types';
import { TaskCard } from './TaskCard';
import { StatusBadge } from './StatusBadge';
import { AgentActivitySummary } from './AgentActivitySummary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { timeAgo } from '@/lib/time';

export type ViewMode = 'cards' | 'table';

interface TaskListProps {
  tasks: Task[];
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
  onResume?: (id: string) => void;
  viewMode: ViewMode;
}

function repoName(repoPath: string): string {
  return repoPath.split('/').pop() || repoPath;
}

const TaskTableRow = memo(function TaskTableRow({
  task,
  onClose,
  onDelete,
  onResume,
}: {
  task: Task;
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
  onResume?: (id: string) => void;
}) {
  const navigate = useNavigate();
  const canResume = (task.status === 'closed' || task.status === 'error') && !!task.worktree;
  const isActive = task.status === 'running' || task.status === 'setting_up';
  const activeAgents = task.agents?.filter((a) => a.status !== 'stopped') ?? [];

  return (
    <tr
      className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-accent/50"
      onClick={() => navigate(`/tasks/${task.id}`)}
    >
      <td className="py-2 pr-3 pl-3">
        <StatusBadge status={task.derived_status || task.status} />
      </td>
      <td className="py-2 pr-3">
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium">{task.title}</span>
          {task.description && (
            <span className="block truncate text-xs text-muted-foreground">
              {task.description}
            </span>
          )}
        </div>
      </td>
      <td className="py-2 pr-3">
        <Badge variant="outline" className="text-xs font-normal">
          {repoName(task.repo_path)}
        </Badge>
      </td>
      <td className="py-2 pr-3">
        {activeAgents.length > 0 && task.status === 'running' ? (
          <AgentActivitySummary
            agents={task.agents ?? []}
            pendingPrompts={task.pending_prompts}
            compact
          />
        ) : (
          <span className="tabular-nums text-xs text-muted-foreground">
            {activeAgents.length > 0 ? `${activeAgents.length} agent${activeAgents.length > 1 ? 's' : ''}` : '—'}
          </span>
        )}
      </td>
      <td className="tabular-nums py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">
        {timeAgo(task.created_at)}
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {task.pr_url && (
            <a
              href={task.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:underline"
            >
              PR #<span className="tabular-nums">{task.pr_number}</span>
            </a>
          )}
          {canResume && onResume && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-green-400"
              title="Resume agents"
              onClick={() => onResume(task.id)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </Button>
          )}
          {isActive ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-yellow-500"
              title="Close task"
              onClick={() => onClose(task.id)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
              title="Delete task"
              onClick={() => onDelete(task.id)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
});

function TaskTableView({
  tasks,
  onClose,
  onDelete,
  onResume,
}: Omit<TaskListProps, 'viewMode'>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
            <th className="py-2 pr-3 pl-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Task</th>
            <th className="py-2 pr-3 font-medium">Project</th>
            <th className="py-2 pr-3 font-medium">Agents</th>
            <th className="py-2 pr-3 font-medium">Created</th>
            <th className="py-2 pr-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <TaskTableRow
              key={task.id}
              task={task}
              onClose={onClose}
              onDelete={onDelete}
              onResume={onResume}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TaskList({ tasks, onClose, onDelete, onResume, viewMode }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <p className="text-lg">No tasks yet</p>
        <p className="text-sm">Create a task to get started</p>
      </div>
    );
  }

  if (viewMode === 'table') {
    return <TaskTableView tasks={tasks} onClose={onClose} onDelete={onDelete} onResume={onResume} />;
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
