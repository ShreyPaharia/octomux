import type { ReactNode } from 'react';

import { repoName } from '@/lib/utils';
import type { RunMode, Task } from '../../../server/types';

const MODE_BRANCH_LABEL: Record<RunMode, string> = {
  new: 'Branch',
  existing: 'Worktree head',
  none: 'Branch',
  scratch: 'Branch',
};

export function TaskDetailMeta({ task }: { task: Task }) {
  const runMode: RunMode = task.run_mode ?? 'new';

  return (
    <div
      data-testid="task-detail-meta"
      className="diff-pane-header flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2.5 text-xs"
    >
      {task.repo_path && <MetaItem label="Repo" value={repoName(task.repo_path)} />}
      {task.branch && (
        <MetaItem
          label={MODE_BRANCH_LABEL[runMode]}
          value={runMode === 'none' ? `${task.branch} (working tree)` : task.branch}
          valueClassName="font-mono text-primary"
        />
      )}
      {task.base_branch && <MetaItem label="Base" value={task.base_branch} mono />}
      {task.pr_url && (
        <MetaItem
          label="PR"
          value={
            <a
              href={task.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary hover:underline"
            >
              #{task.pr_number}
            </a>
          }
        />
      )}
    </div>
  );
}

function MetaItem({
  label,
  value,
  mono,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-soft">
        {label}
      </span>
      <span
        className={valueClassName ?? (mono ? 'font-mono text-muted-foreground' : 'text-foreground')}
      >
        {value}
      </span>
    </div>
  );
}
