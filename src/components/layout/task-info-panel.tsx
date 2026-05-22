import type { ReactNode } from 'react';

import { GlassPanel } from '@/components/ui/glass-panel';
import { cn } from '@/lib/utils';

export function TaskInfoPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <GlassPanel
      level={2}
      specular
      className={cn(
        'rounded-2xl p-4 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]',
        className,
      )}
    >
      {children}
    </GlassPanel>
  );
}
