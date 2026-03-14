import { memo } from 'react';
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

export const TaskFilterBar = memo(function TaskFilterBar({
  activeStatus,
  counts,
  onStatusChange,
  repos,
  activeRepo,
  onRepoChange,
}: TaskFilterBarProps) {
  const tabs = [
    { key: 'open' as const, label: `Open (${counts.open})` },
    { key: 'backlog' as const, label: `Backlog (${counts.backlog})` },
    { key: 'closed' as const, label: `Closed (${counts.closed})` },
  ];

  return (
    <div className="mb-4 flex items-center justify-between border-b border-border">
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
            {tab.label}
          </button>
        ))}
      </div>
      {repos.length > 1 && (
        <select
          value={activeRepo}
          onChange={(e) => onRepoChange(e.target.value)}
          title={activeRepo || 'All projects'}
          className="mb-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
        >
          <option value="">All projects</option>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repoName(repo)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
});
