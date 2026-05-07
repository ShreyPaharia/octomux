import { useCallback, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContext } from '@/lib/tasks-context';
import { TaskBoard } from '@/components/TaskBoard';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { PlusIcon } from '@/components/icons';
import { repoName } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import type { Task } from '../../server/types';

function NewTaskButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      className="bg-[#3B82F6] text-white hover:bg-[#3B82F6]/90"
      style={{
        boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.35), 0 0 24px 0 rgba(59, 130, 246, 0.35)',
      }}
    >
      <PlusIcon data-icon="inline-start" />
      NEW TASK
    </Button>
  );
}

// ─── Board-specific filter bar ─────────────────────────────────────────────

interface BoardFilterBarProps {
  repos: string[];
  activeRepo: string;
  onRepoChange: (repo: string) => void;
  needsAttention: boolean;
  onNeedsAttentionChange: (v: boolean) => void;
  search: string;
  onSearchChange: (v: string) => void;
}

function RepoFilterDropdown({
  repos,
  activeRepo,
  onRepoChange,
}: {
  repos: string[];
  activeRepo: string;
  onRepoChange: (repo: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-[#8a8a8a] transition-colors hover:text-foreground"
          >
            {activeRepo ? (
              <Badge variant="outline" className="text-xs font-normal">
                {repoName(activeRepo)}
              </Badge>
            ) : (
              <span>all repos</span>
            )}
            <ChevronDownIcon size={12} className="text-[#8a8a8a]" />
          </button>
        }
      />
      <PopoverContent align="end" side="bottom" sideOffset={4} className="w-[200px] p-0">
        <div className="flex flex-col">
          <button
            type="button"
            className={`px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${!activeRepo ? 'bg-muted font-medium' : ''}`}
            onClick={() => {
              onRepoChange('');
              setOpen(false);
            }}
          >
            All projects
          </button>
          {repos.map((repo) => (
            <button
              key={repo}
              type="button"
              className={`flex items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${repo === activeRepo ? 'bg-muted font-medium' : ''}`}
              onClick={() => {
                onRepoChange(repo);
                setOpen(false);
              }}
            >
              <Badge variant="outline" className="text-xs font-normal">
                {repoName(repo)}
              </Badge>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BoardFilterBar({
  repos,
  activeRepo,
  onRepoChange,
  needsAttention,
  onNeedsAttentionChange,
  search,
  onSearchChange,
}: BoardFilterBarProps) {
  return (
    <GlassPanel
      level={1}
      specular
      data-testid="board-filter-bar"
      className="my-3 flex items-center justify-between gap-2 rounded-[14px] px-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        {/* Needs attention toggle */}
        <button
          type="button"
          data-testid="filter-needs-attention"
          data-active={needsAttention ? 'true' : undefined}
          onClick={() => onNeedsAttentionChange(!needsAttention)}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium tracking-wider uppercase transition-colors',
            needsAttention ? 'text-amber-400' : 'text-[#8a8a8a] hover:text-foreground',
          )}
          style={
            needsAttention
              ? {
                  backgroundColor: 'rgba(251, 191, 36, 0.08)',
                  boxShadow: 'inset 0 0 0 1px rgba(251, 191, 36, 0.2)',
                }
              : undefined
          }
        >
          <span>⚠</span>
          <span>Needs attention</span>
        </button>

        {/* Free-text search */}
        <input
          type="search"
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-7 rounded-md border border-[#2f2f2f] bg-transparent px-2.5 text-[11px] text-foreground placeholder:text-[#4a4a4a] focus:border-[#3B82F6] focus:outline-none"
          style={{ width: '160px' }}
          data-testid="board-search"
        />
      </div>

      <div className="flex items-center gap-2">
        {repos.length > 1 && (
          <>
            <span
              aria-hidden
              className="h-5 w-px"
              style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}
            />
            <RepoFilterDropdown repos={repos} activeRepo={activeRepo} onRepoChange={onRepoChange} />
          </>
        )}
      </div>
    </GlassPanel>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────

export default function TasksPage() {
  const { tasks, loading, error, refresh } = useTasksContext();
  const navigate = useNavigate();
  const openCreate = useCallback(() => navigate('/'), [navigate]);

  // Board filters
  const [activeRepo, setActiveRepo] = useState(
    () => localStorage.getItem('octomux-repo-filter') ?? '',
  );
  const [needsAttention, setNeedsAttention] = useState(false);
  const [search, setSearch] = useState('');

  const repos = useMemo(() => {
    const paths = new Set(tasks.map((t) => t.repo_path));
    return [...paths].sort((a, b) => repoName(a).localeCompare(repoName(b)));
  }, [tasks]);

  const handleRepoChange = useCallback((repo: string) => {
    localStorage.setItem('octomux-repo-filter', repo);
    setActiveRepo(repo);
  }, []);

  // Apply board-level filters (repo + needs attention + search)
  const filteredTasks = useMemo<Task[]>(() => {
    return tasks.filter((t) => {
      if (activeRepo && t.repo_path !== activeRepo) return false;
      if (needsAttention) {
        const isAttention =
          t.workflow_status === 'human_review' || t.runtime_state === 'error';
        if (!isAttention) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        const inTitle = t.title.toLowerCase().includes(q);
        const inSummary = (t.current_summary ?? '').toLowerCase().includes(q);
        if (!inTitle && !inSummary) return false;
      }
      return true;
    });
  }, [tasks, activeRepo, needsAttention, search]);

  // Pass-through for optimistic updates from board (real WS refresh handles persistence)
  const handleTasksChange = useCallback(() => {
    // Let the WS + refresh cycle handle eventual consistency.
    // The board applies optimistic updates locally until WS arrives.
    refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-col px-4 py-4">
        {error && (
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
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            }
            heading="Unable to load tasks"
            subtext={`Check that the server is running on port 7777. ${error}`}
            action={
              <Button variant="outline" size="sm" onClick={refresh}>
                Retry
              </Button>
            }
          />
        )}

        {loading ? (
          <div className="flex gap-4 overflow-x-auto">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="h-48 w-[260px] flex-none animate-pulse rounded-xl border border-border bg-card"
              />
            ))}
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-end justify-between">
              <div className="flex flex-col gap-2">
                <span
                  data-testid="page-eyebrow"
                  className="font-mono text-[11px] font-bold text-[#B5B5BD]"
                  style={{ letterSpacing: '1.5px' }}
                >
                  // TASKS
                </span>
                <h1
                  className="font-display text-[32px] font-bold leading-[1.1] tracking-tight"
                  style={{ letterSpacing: '-0.5px' }}
                >
                  Command center
                </h1>
              </div>
              <NewTaskButton onClick={openCreate} />
            </div>

            <BoardFilterBar
              repos={repos}
              activeRepo={activeRepo}
              onRepoChange={handleRepoChange}
              needsAttention={needsAttention}
              onNeedsAttentionChange={setNeedsAttention}
              search={search}
              onSearchChange={setSearch}
            />
          </>
        )}
      </div>

      {/* Board — takes remaining height, scrolls horizontally */}
      {!loading && !error && (
        <div className="min-h-0 flex-1 overflow-hidden px-4">
          <TaskBoard tasks={filteredTasks} onTasksChange={handleTasksChange} />
        </div>
      )}
    </div>
  );
}
