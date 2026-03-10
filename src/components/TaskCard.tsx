import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Task } from '../../server/types';
import { StatusBadge } from './StatusBadge';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function repoName(repoPath: string): string {
  return repoPath.split('/').pop() || repoPath;
}

interface TaskCardProps {
  task: Task;
  onDelete: (id: string) => void;
  onResume?: (id: string) => void;
}

export function TaskCard({ task, onDelete, onResume }: TaskCardProps) {
  const navigate = useNavigate();
  const canResume = (task.status === 'closed' || task.status === 'error') && !!task.worktree;

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-accent/50"
      onClick={() => navigate(`/tasks/${task.id}`)}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="min-w-0 text-base leading-snug line-clamp-2">
            {task.title}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge status={task.status} />
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {timeAgo(task.created_at)}
            </span>
          </div>
        </div>
        <CardDescription className="line-clamp-1">{task.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Badge variant="outline" className="text-xs font-normal">
              {repoName(task.repo_path)}
            </Badge>
            {task.branch && <span className="font-mono text-xs">{task.branch}</span>}
          </div>
          <div className="flex items-center gap-2">
            {task.pr_url && (
              <a
                href={task.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                PR #{task.pr_number}
              </a>
            )}
            {task.error && (
              <span className="text-xs text-destructive" title={task.error}>
                Error
              </span>
            )}
            {canResume && onResume && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-green-400"
                title="Resume agents"
                onClick={(e) => {
                  e.stopPropagation();
                  onResume(task.id);
                }}
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
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
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
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
