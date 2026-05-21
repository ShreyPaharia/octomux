import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export type GlassLevel = 1 | 2 | 3;

export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  level?: GlassLevel;
  specular?: boolean;
  /** Dark app-chrome material (sidebar-style), not content tint. */
  chrome?: boolean;
}

const tintByLevel: Record<GlassLevel, string> = {
  1: 'bg-glass-l1 glass-blur-l1',
  2: 'bg-glass-l2 glass-blur-l2',
  3: 'bg-glass-l3 glass-blur-l3',
};

const edgeByLevel: Record<GlassLevel, string> = {
  1: 'border border-glass-edge',
  2: 'border border-glass-edge',
  3: 'border border-glass-edge-strong',
};

const SPECULAR_SHADOW = 'inset 0 1px 0 0 rgba(255, 255, 255, 0.22)';

export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(function GlassPanel(
  { level = 1, specular = false, chrome = false, className, style, children, ...rest },
  ref,
) {
  const mergedStyle: CSSProperties | undefined = specular
    ? { boxShadow: SPECULAR_SHADOW, ...style }
    : style;
  return (
    <div
      ref={ref}
      data-glass-level={chrome ? undefined : level}
      data-glass-chrome={chrome ? 'true' : undefined}
      data-glass-specular={specular ? 'true' : undefined}
      className={cn(
        chrome
          ? 'glass-chrome glass-blur-l1 border border-glass-edge'
          : [tintByLevel[level], edgeByLevel[level]],
        className,
      )}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </div>
  );
});
