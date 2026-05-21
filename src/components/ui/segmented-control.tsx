import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  testId?: string;
  ariaLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-input bg-glass-l1 p-0.5',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={opt.testId}
            data-active={active ? 'true' : undefined}
            aria-label={opt.ariaLabel ?? (typeof opt.label === 'string' ? opt.label : undefined)}
            aria-pressed={active}
            className={cn(
              'focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-primary/15 text-primary shadow-sm'
                : 'text-muted-soft hover:text-foreground',
            )}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
