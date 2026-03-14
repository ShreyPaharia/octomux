import { memo } from 'react';
import { Badge } from '@/components/ui/badge';

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30' },
  setting_up: {
    label: 'Setting up',
    className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  },
  running: { label: 'Running', className: 'bg-green-500/20 text-green-400 border-green-500/30' },
  closed: { label: 'Closed', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  error: { label: 'Error', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
  working: { label: 'Working', className: 'bg-green-500/20 text-green-400 border-green-500/30' },
  needs_attention: {
    label: 'Needs attention',
    className: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  },
  done: { label: 'Done', className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
};

const fallbackConfig = {
  label: 'Unknown',
  className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
};

export const StatusBadge = memo(function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] || fallbackConfig;
  return (
    <Badge variant="outline" className={config.className}>
      {(status === 'running' || status === 'working') && (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />
      )}
      {config.label}
    </Badge>
  );
});
