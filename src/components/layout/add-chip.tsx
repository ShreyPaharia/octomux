import { cn } from '@/lib/utils';

export function AddChip({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'focus-ring inline-flex items-center gap-1 rounded-lg border border-primary/40 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 active:bg-primary/30 disabled:opacity-40',
        className,
      )}
      style={{ backgroundColor: 'rgba(59, 130, 246, 0.12)' }}
    >
      {label}
    </button>
  );
}
