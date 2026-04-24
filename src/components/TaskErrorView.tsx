import { TriangleAlertIcon } from '@/components/icons';
import { timeAgo } from '@/lib/time';
import type { Task } from '../../server/types';

interface Props {
  task: Task;
  onRetry: () => void;
  onDelete: () => void;
  onViewLogs?: () => void;
  logLines?: string[];
}

export function TaskErrorView({ task, onRetry, onDelete, onViewLogs, logLines }: Props) {
  const tail =
    logLines && logLines.length > 0
      ? logLines
      : task.error
        ? [task.error]
        : ['(no log output available)'];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="task-error-view">
      <div
        data-testid="task-error-banner"
        className="flex items-start gap-3 border-b border-[#EF444433] bg-[#EF44440F] px-5 py-3.5"
        role="alert"
      >
        <TriangleAlertIcon size={16} className="mt-0.5 shrink-0 text-[#EF4444]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="text-[13px] font-semibold text-white">Task failed</div>
          <div className="whitespace-pre-wrap font-mono text-[11px] text-[#B5B5BD]">
            {task.error || 'No error details.'}
          </div>
        </div>
        <button
          type="button"
          data-testid="task-error-retry"
          onClick={onRetry}
          className="shrink-0 rounded-md bg-[#EF4444] px-3 py-1.5 text-[12px] font-bold text-white hover:bg-[#DC2626]"
        >
          Retry
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[#0B0C0F] px-5 py-4 font-mono text-[11px] text-[#8a8a8a]">
        {tail.map((line, idx) => (
          <div key={idx} className="whitespace-pre-wrap leading-snug">
            {line}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-glass-edge bg-[#FFFFFF05] px-5 py-2.5">
        <span className="font-mono text-[11px] text-[#B5B5BD]">
          Exited · {timeAgo(task.updated_at)}
        </span>
        <div className="flex-1" />
        {onViewLogs && (
          <button
            type="button"
            onClick={onViewLogs}
            className="bg-glass-l1 glass-blur-l1 rounded-md border border-glass-edge px-3 py-1.5 text-[12px] font-medium text-[#D0D0D0] hover:bg-[#FFFFFF14]"
          >
            View logs
          </button>
        )}
        <button
          type="button"
          data-testid="task-error-delete"
          onClick={onDelete}
          className="rounded-md border border-[#EF444433] bg-[#EF44440F] px-3 py-1.5 text-[12px] font-semibold text-[#EF4444] hover:bg-[#EF444422]"
        >
          Delete task
        </button>
      </div>
    </div>
  );
}
