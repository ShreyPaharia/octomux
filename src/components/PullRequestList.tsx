import type { TaskPullRequest, PullRequestState } from '@octomux/types';
import { PullRequestIcon } from './icons';

interface PullRequestListProps {
  pullRequests: TaskPullRequest[];
}

const STATE_STYLES: Record<PullRequestState, string> = {
  open: 'bg-green-500/15 text-green-400',
  merged: 'bg-purple-500/15 text-purple-400',
  closed: 'bg-zinc-500/15 text-zinc-400',
};

export function PullRequestList({ pullRequests }: PullRequestListProps) {
  if (pullRequests.length === 0) return null;

  const openCount = pullRequests.filter((pr) => pr.state === 'open').length;
  const mergedCount = pullRequests.filter((pr) => pr.state === 'merged').length;
  const closedCount = pullRequests.filter((pr) => pr.state === 'closed').length;

  const rollupParts: string[] = [];
  if (openCount > 0) rollupParts.push(`${openCount} open`);
  if (mergedCount > 0) rollupParts.push(`${mergedCount} merged`);
  if (closedCount > 0) rollupParts.push(`${closedCount} closed`);

  return (
    <div className="flex flex-col gap-3" data-testid="pull-request-list">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Pull Requests
        </h2>
        <span className="text-[10px] text-muted-soft" data-testid="pr-rollup">
          {rollupParts.join(' · ')}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {pullRequests.map((pr) => (
          <div
            key={pr.id}
            className="flex items-center gap-2 rounded-lg border border-glass-edge bg-glass-l1 px-3 py-2"
            data-testid={`pr-row-${pr.id}`}
          >
            <PullRequestIcon className="shrink-0 text-muted-soft" />
            <div className="min-w-0 flex-1">
              {pr.url ? (
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-primary hover:underline"
                >
                  {pr.number ? `#${pr.number}` : pr.branch}
                </a>
              ) : (
                <span className="text-[11px] text-foreground">
                  {pr.number ? `#${pr.number}` : pr.branch}
                </span>
              )}
              <span className="ml-1.5 truncate text-[10px] text-muted-soft">{pr.branch}</span>
            </div>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_STYLES[pr.state]}`}
            >
              {pr.state}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
