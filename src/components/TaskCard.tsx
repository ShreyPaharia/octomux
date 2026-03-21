import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Task } from '../../server/types';
import { StatusBadge } from './StatusBadge';
import { AgentActivitySummary } from './AgentActivitySummary';
import { PermissionPromptRow } from './PermissionPromptRow';
import { timeAgo } from '@/lib/time';

function repoName(repoPath: string): string {
  return repoPath.split('/').pop() || repoPath;
}

interface TaskCardProps {
  task: Task;
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
  onResume?: (id: string) => void;
}

export const TaskCard = memo(function TaskCard({
  task,
  onClose,
  onDelete,
  onResume,
}: TaskCardProps) {
  const navigate = useNavigate();
  const canResume = (task.status === 'closed' || task.status === 'error') && !!task.worktree;
  const isActive = task.status === 'running' || task.status === 'setting_up';

  return (
    <Card
      className="cursor-pointer bg-[#0A0A0A] border border-[#2f2f2f] transition-colors hover:bg-[#141414]"
      onClick={() => navigate(`/tasks/${task.id}`)}
    >
      <CardHeader className="px-6 py-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="font-display min-w-0 text-base leading-snug line-clamp-2">
            {task.title}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge status={task.derived_status || task.status} />
            <span className="text-xs tabular-nums whitespace-nowrap text-muted-foreground">
              {timeAgo(task.created_at)}
            </span>
          </div>
        </div>
        <CardDescription className="line-clamp-1 font-mono text-[#6a6a6a]">
          {task.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-5 pt-0">
        {/* Metadata row */}
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className="font-normal bg-[#141414] border-[#2f2f2f] px-2 py-1 text-xs"
            >
              {repoName(task.repo_path)}
            </Badge>
            {task.branch && (
              <>
                <span className="text-[#2f2f2f]">|</span>
                <span className="font-mono text-[#3B82F6]">{task.branch}</span>
              </>
            )}
            {task.agents && task.agents.length > 0 && (
              <>
                <span className="text-[#2f2f2f]">|</span>
                <span className="text-[#6a6a6a]">
                  {task.agents.length} agent{task.agents.length !== 1 ? 's' : ''}
                </span>
              </>
            )}
            {task.pr_url && (
              <>
                <span className="text-[#2f2f2f]">|</span>
                <a
                  href={task.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#3B82F6] hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  PR #<span className="tabular-nums">{task.pr_number}</span>
                </a>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
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
            {isActive ? (
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-yellow-500"
                title="Close task"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(task.id);
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
            )}
          </div>
        </div>

        {/* Error banner */}
        {task.error && (
          <div className="mt-3 rounded-none bg-[#EF444410] px-3 py-2 text-xs" title={task.error}>
            <span className="font-bold text-red-500">Error:</span>{' '}
            <span className="text-red-400">{task.error}</span>
          </div>
        )}

        {/* Agent activity */}
        {task.agents && task.agents.length > 0 && task.status === 'running' && (
          <div className="mt-3">
            <AgentActivitySummary agents={task.agents} pendingPrompts={task.pending_prompts} />
          </div>
        )}
        {task.pending_prompts && task.pending_prompts.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {task.pending_prompts.map((pp) => (
              <PermissionPromptRow key={pp.id} prompt={pp} taskId={task.id} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
