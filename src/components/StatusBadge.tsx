import { memo } from 'react';

import { StatusGlyph } from './ui/status-glyph';

const labels: Record<string, string> = {
  draft: 'DRAFT',
  setting_up: 'SETTING_UP',
  running: 'RUNNING',
  closed: 'CLOSED',
  error: 'ERROR',
  working: 'WORKING',
  needs_attention: 'ALERT',
  done: 'DONE',
};

const colors: Record<string, string> = {
  draft: 'text-[#6a6a6a]',
  setting_up: 'text-[#FFB800]',
  running: 'text-[#22C55E]',
  closed: 'text-[#6a6a6a]',
  error: 'text-[#EF4444]',
  working: 'text-[#22C55E]',
  needs_attention: 'text-[#FFB800]',
  done: 'text-[#22C55E]',
};

export const StatusBadge = memo(function StatusBadge({ status }: { status: string }) {
  const label = labels[status] || 'UNKNOWN';
  const colorClass = colors[status] || 'text-[#6a6a6a]';
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1 text-xs font-bold tracking-wider uppercase ${colorClass}`}
    >
      <StatusGlyph status={status} size={10} />
      <span>{label}</span>
    </span>
  );
});
