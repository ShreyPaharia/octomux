import { cn } from '@/lib/utils';

interface ReviewProgressBarProps {
  done: number;
  total: number;
  className?: string;
  'data-testid'?: string;
}

export function ReviewProgressBar({
  done,
  total,
  className,
  'data-testid': testId,
}: ReviewProgressBarProps) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div
      data-testid={testId}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-glass-l2', className)}
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${done} of ${total} files reviewed`}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
