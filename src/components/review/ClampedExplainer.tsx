import { useState } from 'react';
import { cn } from '@/lib/utils';

const LINE_CLAMP: Record<number, string> = {
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
};

export interface ClampedExplainerProps {
  text: string;
  /** Collapsed line clamp (Tailwind line-clamp-N). */
  lines?: 2 | 3 | 4;
  /** Show expand control when text exceeds this character count. */
  clampChars?: number;
  className?: string;
  'data-testid'?: string;
}

export function ClampedExplainer({
  text,
  lines = 2,
  clampChars = 140,
  className,
  'data-testid': testId,
}: ClampedExplainerProps) {
  const [expanded, setExpanded] = useState(false);
  const needsToggle = text.length > clampChars;
  const lineClass = LINE_CLAMP[lines] ?? 'line-clamp-2';

  if (!needsToggle) {
    return (
      <p data-testid={testId} className={className}>
        {text}
      </p>
    );
  }

  return (
    <div data-testid={testId}>
      <p className={cn(className, !expanded && lineClass)}>{text}</p>
      <button
        type="button"
        className="mt-0.5 text-[10px] font-medium text-primary hover:underline"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}
