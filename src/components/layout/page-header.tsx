import type { ReactNode } from 'react';

import { GlassPanel } from '@/components/ui/glass-panel';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  eyebrow?: string;
  /** Rich eyebrow row (e.g. inbox meta). Takes precedence over `eyebrow` string. */
  eyebrowContent?: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Glass band (settings) vs inline title (tasks/home). */
  variant?: 'glass' | 'plain';
  className?: string;
  titleTestId?: string;
  eyebrowTestId?: string;
}

export function PageHeader({
  eyebrow,
  eyebrowContent,
  title,
  description,
  actions,
  variant = 'plain',
  className,
  titleTestId,
  eyebrowTestId,
}: PageHeaderProps) {
  const content = (
    <div
      className={cn(
        'motion-fade-in flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between',
        variant === 'glass' && 'px-6 py-4',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrowContent ? (
          <div data-testid={eyebrowTestId}>{eyebrowContent}</div>
        ) : (
          eyebrow && (
            <span
              data-testid={eyebrowTestId}
              className="text-[11px] font-medium tracking-wide text-muted-foreground"
            >
              {eyebrow}
            </span>
          )
        )}
        <h1
          data-testid={titleTestId}
          className="font-display text-2xl font-semibold leading-tight tracking-tight text-foreground sm:text-[28px]"
        >
          {title}
        </h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && (
        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      )}
    </div>
  );

  if (variant === 'glass') {
    return (
      <GlassPanel level={1} className={cn('rounded-none border-x-0 border-t-0', className)}>
        {content}
      </GlassPanel>
    );
  }

  return <header className={className}>{content}</header>;
}
