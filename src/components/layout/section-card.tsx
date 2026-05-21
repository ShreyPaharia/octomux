import type { ReactNode } from 'react';

import { GlassPanel } from '@/components/ui/glass-panel';
import { SECTION_HEADER_DIVIDER } from '@/lib/design-tokens';

export interface SectionCardProps {
  id: string;
  title: string;
  count?: string | number;
  help?: string;
  trailing?: ReactNode;
  children: ReactNode;
  scrollRef?: (el: HTMLElement | null) => void;
}

export function SectionCard({
  id,
  title,
  count,
  help,
  trailing,
  children,
  scrollRef,
}: SectionCardProps) {
  return (
    <section id={`section-${id}`} ref={scrollRef} className="mb-6 scroll-mt-6">
      <GlassPanel level={2} className="rounded-2xl px-5">
        <header className="flex items-center justify-between" style={SECTION_HEADER_DIVIDER}>
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            {count !== undefined && <span className="text-xs text-muted-soft">{count}</span>}
            {help && <span className="text-xs text-muted-soft">{help}</span>}
          </div>
          {trailing}
        </header>
        <div className="py-2">{children}</div>
      </GlassPanel>
    </section>
  );
}
