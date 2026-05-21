import type { ReactNode } from 'react';

export function InboxSectionHeader({
  accentClass,
  lineClass,
  icon,
  title,
  count,
  meta,
}: {
  accentClass: string;
  lineClass?: string;
  icon: ReactNode;
  title: string;
  count?: string | number;
  meta?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className={`flex items-center justify-center ${accentClass}`} aria-hidden>
        {icon}
      </span>
      <span className={`text-xs font-semibold tracking-wide ${accentClass}`}>{title}</span>
      {count !== undefined && (
        <span className="text-xs font-medium tabular-nums text-muted-soft">{count}</span>
      )}
      {meta && <span className="text-xs text-muted-soft">{meta}</span>}
      <span className={`ml-1 h-px flex-1 ${lineClass ?? 'bg-glass-edge'}`} aria-hidden />
    </div>
  );
}
