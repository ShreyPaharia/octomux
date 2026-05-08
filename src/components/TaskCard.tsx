import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import { StatusGlyph } from '@/components/ui/status-glyph';
import type { Task } from '../../server/types';
import { StatusBadge } from './StatusBadge';
import { AgentActivitySummary } from './AgentActivitySummary';
import { PermissionPromptRow } from './PermissionPromptRow';
import { timeAgo } from '@/lib/time';
import { repoName } from '@/lib/utils';

interface TaskCardProps {
  task: Task;
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
  onResume?: (id: string) => void;
}

const EM_DASH = '—';

function ModeBadge({ mode }: { mode: Task['run_mode'] }) {
  const label =
    mode === 'scratch'
      ? 'SCRATCH'
      : mode === 'existing'
        ? 'EXISTING'
        : mode === 'none'
          ? 'NONE'
          : 'NEW';
  return (
    <span
      className="font-mono text-[10px] font-bold tracking-wider text-[#8a8a8a]"
      style={{
        padding: '2px 6px',
        backgroundColor: 'rgba(255, 255, 255, 0.06)',
        boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.08)',
      }}
    >
      {label}
    </span>
  );
}

function TelemetryRow({ task: _task }: { task: Task }) {
  const parts = [
    EM_DASH, // model (e.g. opus-4.7) — not tracked
    `${EM_DASH} ctx`, // context tokens
    EM_DASH, // cost
    EM_DASH, // diff stats
    `tests ${EM_DASH}`,
    `lint ${EM_DASH}`,
  ];
  return (
    <div
      data-testid="telemetry-row"
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-[#6a6a6a]"
    >
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center">
          {i > 0 && <span className="mr-2 text-[#2f2f2f]">·</span>}
          <span className="tabular-nums">{p}</span>
        </span>
      ))}
    </div>
  );
}

export const TaskCard = memo(function TaskCard({
  task,
  onClose,
  onDelete,
  onResume,
}: TaskCardProps) {
  const navigate = useNavigate();
  const canResume = (task.runtime_state === 'idle' || task.runtime_state === 'error') && !!task.worktree;
  const isActive = task.runtime_state === 'running' || task.runtime_state === 'setting_up';
  const displayStatus = task.derived_status || task.runtime_state;

  return (
    <GlassPanel
      level={2}
      specular
      onClick={() => navigate(`/tasks/${task.id}`)}
      className="group cursor-pointer transition-colors hover:bg-glass-l3"
      style={{
        borderRadius: '14px',
        boxShadow:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.22), 0 12px 30px -8px rgba(0, 0, 0, 0.55)',
      }}
    >
      <div className="flex items-start gap-3 px-5 py-4">
        {/* Status dot */}
        <div className="shrink-0 pt-1.5">
          <StatusGlyph status={displayStatus} size={12} />
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          {/* Title + mode badge */}
          <div className="flex items-center gap-2">
            <h3
              title={task.title}
              aria-label={task.title}
              className="font-display min-w-0 truncate text-base font-semibold leading-snug"
            >
              {task.title}
            </h3>
            <ModeBadge mode={task.run_mode} />
          </div>

          {task.description && (
            <p className="mt-0.5 line-clamp-1 font-mono text-xs text-[#6a6a6a]">
              {task.description}
            </p>
          )}

          {/* Metadata row */}
          <div className="mt-2 flex items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className="border-[#2f2f2f] bg-[#141414] px-2 py-0.5 text-xs font-normal"
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

          {/* Telemetry row */}
          <TelemetryRow task={task} />

          {/* Error banner */}
          {task.error && (
            <div
              className="mt-2 px-3 py-2 text-xs"
              style={{ backgroundColor: 'rgba(239, 68, 68, 0.06)' }}
              title={task.error}
            >
              <span className="font-bold text-red-500">Error:</span>{' '}
              <span className="text-red-400">{task.error}</span>
            </div>
          )}

          {task.agents && task.agents.length > 0 && task.runtime_state === 'running' && (
            <div className="mt-2">
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
        </div>

        {/* Right: status pill + timestamp + actions + arrow */}
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <StatusBadge status={displayStatus} variant="pill" />
            <span className="text-xs tabular-nums whitespace-nowrap text-muted-foreground">
              {timeAgo(task.created_at)}
            </span>
          </div>
          <div className="flex items-center gap-1">
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
            <span
              aria-hidden
              className="text-sm text-[#6a6a6a] opacity-0 transition-opacity group-hover:opacity-100"
            >
              →
            </span>
          </div>
        </div>
      </div>
    </GlassPanel>
  );
});
