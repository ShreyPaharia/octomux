import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from '../../server/types';

const statusConfig: Record<TaskStatus, { label: string; className: string }> = {
  created: { label: 'Created', className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30' },
  setting_up: {
    label: 'Setting up',
    className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  },
  running: { label: 'Running', className: 'bg-green-500/20 text-green-400 border-green-500/30' },
  done: { label: 'Done', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
  },
  error: { label: 'Error', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const config = statusConfig[status];
  return (
    <Badge variant="outline" className={config.className}>
      {status === 'running' && (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />
      )}
      {config.label}
    </Badge>
  );
}
