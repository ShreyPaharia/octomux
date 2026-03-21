import { memo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import type { StatusTab } from '@/lib/use-task-filters';

interface TaskFilterBarProps {
  activeStatus: StatusTab;
  counts: { open: number; closed: number; backlog: number };
  onStatusChange: (status: StatusTab) => void;
  repos: string[];
  activeRepo: string;
  onRepoChange: (repo: string) => void;
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
            className="mb-1 flex items-center gap-1.5 rounded border border-[#2f2f2f] bg-background px-[14px] py-[8px] text-[11px] text-[#8a8a8a] transition-colors hover:bg-muted"
          >
            {activeRepo ? (
              <Badge variant="outline" className="text-xs font-normal">
                {repoName(activeRepo)}
              </Badge>
            ) : (
              <span>ALL REPOS</span>
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
              className="text-[#8a8a8a]"
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

export const TaskFilterBar = memo(function TaskFilterBar({
  activeStatus,
  counts,
  onStatusChange,
  repos,
  activeRepo,
  onRepoChange,
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
            className={`px-[16px] py-[10px] text-xs tracking-wider uppercase ${
              activeStatus === tab.key
                ? 'border-b-2 border-[#3B82F6] font-bold text-[#3B82F6]'
                : 'font-medium text-[#6a6a6a] hover:text-[#8a8a8a]'
            }`}
            onClick={() => onStatusChange(tab.key)}
          >
            {tab.label}{' '}
            <span
              className={`tabular-nums ${activeStatus === tab.key ? 'text-[#3B82F6]' : 'text-[#6a6a6a]'}`}
            >
              ({tab.count})
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        {repos.length > 1 && (
          <RepoFilterDropdown repos={repos} activeRepo={activeRepo} onRepoChange={onRepoChange} />
        )}
      </div>
    </div>
  );
});
