import { memo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import type { StatusTab } from '@/lib/use-task-filters';
import type { ViewMode } from './TaskList';

interface TaskFilterBarProps {
  activeStatus: StatusTab;
  counts: { open: number; closed: number; backlog: number };
  onStatusChange: (status: StatusTab) => void;
  repos: string[];
  activeRepo: string;
  onRepoChange: (repo: string) => void;
  viewMode: ViewMode;
  onViewChange: (mode: ViewMode) => void;
}

function repoName(repoPath: string): string {
  return repoPath.split('/').pop() || repoPath;
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
            className="mb-1 flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs transition-colors hover:bg-muted"
          >
            {activeRepo ? (
              <Badge variant="outline" className="text-xs font-normal">
                {repoName(activeRepo)}
              </Badge>
            ) : (
              <span>All projects</span>
            )}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted-foreground"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
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

function ViewToggle({
  viewMode,
  onViewChange,
}: {
  viewMode: ViewMode;
  onViewChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="mb-1 flex items-center rounded-md border border-border">
      <button
        type="button"
        title="Card view"
        className={`rounded-l-md px-1.5 py-1 transition-colors ${viewMode === 'cards' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        onClick={() => onViewChange('cards')}
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
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      </button>
      <button
        type="button"
        title="List view"
        className={`rounded-r-md px-1.5 py-1 transition-colors ${viewMode === 'table' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        onClick={() => onViewChange('table')}
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
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export const TaskFilterBar = memo(function TaskFilterBar({
  activeStatus,
  counts,
  onStatusChange,
  repos,
  activeRepo,
  onRepoChange,
  viewMode,
  onViewChange,
}: TaskFilterBarProps) {
  const tabs = [
    { key: 'open' as const, label: 'Open', count: counts.open },
    { key: 'backlog' as const, label: 'Backlog', count: counts.backlog },
    { key: 'closed' as const, label: 'Closed', count: counts.closed },
  ];

  return (
    <div className="mb-3 flex items-center justify-between border-b border-border">
      <div className="flex gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`px-3 py-2 text-sm font-medium ${
              activeStatus === tab.key
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => onStatusChange(tab.key)}
          >
            {tab.label} <span className="tabular-nums text-xs">({tab.count})</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        {repos.length > 1 && (
          <RepoFilterDropdown repos={repos} activeRepo={activeRepo} onRepoChange={onRepoChange} />
        )}
        <ViewToggle viewMode={viewMode} onViewChange={onViewChange} />
      </div>
    </div>
  );
});
