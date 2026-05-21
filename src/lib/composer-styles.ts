import { cn } from '@/lib/utils';

/** Dashed “add” chip (repo, agent, attach). */
export const composerChipAddClass =
  'focus-ring inline-flex items-center gap-1.5 rounded-full border border-dashed border-glass-edge bg-glass-l1/50 px-3 py-1 text-[11px] font-mono text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground';

/** Neutral filled chip (branch, harness, removable attach). */
export const composerChipNeutralClass =
  'inline-flex items-center gap-1.5 rounded-full border border-glass-edge bg-glass-l1/80 px-3 py-1 text-[11px] font-mono';

export function composerChipPrimaryClass(active?: boolean): string {
  return cn(
    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-mono transition-colors',
    active
      ? 'border-primary/40 bg-primary/15 text-primary'
      : 'border-primary/40 bg-primary/10 text-primary',
  );
}

export function composerChipWarningClass(): string {
  return 'inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-[11px] font-mono text-warning';
}

export function composerWorktreeToggleClass(checked: boolean): string {
  return cn(
    'focus-ring inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px] font-mono transition-all duration-150',
    checked
      ? 'border-primary/40 bg-primary/15 text-primary font-semibold'
      : 'border-glass-edge text-muted-foreground hover:bg-glass-l1/50',
  );
}
