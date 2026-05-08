import { memo, type CSSProperties } from 'react';

import { StatusGlyph } from './ui/status-glyph';

const labels: Record<string, string> = {
  idle: 'IDLE',
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
  idle: 'text-[#6a6a6a]',
  draft: 'text-[#6a6a6a]',
  setting_up: 'text-[#FFB800]',
  running: 'text-[#22C55E]',
  closed: 'text-[#6a6a6a]',
  error: 'text-[#EF4444]',
  working: 'text-[#22C55E]',
  needs_attention: 'text-[#FFB800]',
  done: 'text-[#22C55E]',
};

type PillTone = 'green' | 'amber' | 'red' | 'grey';

const toneByStatus: Record<string, PillTone> = {
  running: 'green',
  working: 'green',
  done: 'green',
  setting_up: 'amber',
  needs_attention: 'amber',
  error: 'red',
  idle: 'grey',
  draft: 'grey',
  closed: 'grey',
};

const pillStyles: Record<PillTone, CSSProperties> = {
  green: {
    backgroundColor: 'rgba(34, 197, 94, 0.08)',
    boxShadow: 'inset 0 0 0 1px rgba(34, 197, 94, 0.24)',
  },
  amber: {
    backgroundColor: 'rgba(255, 184, 0, 0.08)',
    boxShadow: 'inset 0 0 0 1px rgba(255, 184, 0, 0.24)',
  },
  red: {
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    boxShadow: 'inset 0 0 0 1px rgba(239, 68, 68, 0.28)',
  },
  grey: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.08)',
  },
};

export const StatusBadge = memo(function StatusBadge({
  status,
  variant = 'text',
}: {
  status: string;
  variant?: 'text' | 'pill';
}) {
  const label = labels[status] || 'UNKNOWN';
  const colorClass = colors[status] || 'text-[#6a6a6a]';

  if (variant === 'pill') {
    const tone = toneByStatus[status] ?? 'grey';
    return (
      <span
        data-status={status}
        data-variant="pill"
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-wider uppercase ${colorClass}`}
        style={pillStyles[tone]}
      >
        <StatusGlyph status={status} size={8} />
        <span>{label}</span>
      </span>
    );
  }

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
