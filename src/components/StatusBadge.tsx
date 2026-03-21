import { memo } from 'react';

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: '[DRAFT]', className: 'text-[#6a6a6a]' },
  setting_up: { label: '[SETTING_UP]', className: 'text-[#FFB800]' },
  running: { label: '[RUNNING]', className: 'text-[#22C55E]' },
  closed: { label: '[CLOSED]', className: 'text-[#6a6a6a]' },
  error: { label: '[ERROR]', className: 'text-[#EF4444]' },
  working: { label: '[WORKING]', className: 'text-[#22C55E]' },
  needs_attention: { label: '[ALERT]', className: 'text-[#FFB800]' },
  done: { label: '[DONE]', className: 'text-[#22C55E]' },
};

const fallbackConfig = { label: '[UNKNOWN]', className: 'text-[#6a6a6a]' };

export const StatusBadge = memo(function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] || fallbackConfig;
  return (
    <span className={`text-xs font-bold uppercase tracking-wider ${config.className}`}>
      {(status === 'running' || status === 'working') && (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse bg-[#22C55E]" />
      )}
      {config.label}
    </span>
  );
});
