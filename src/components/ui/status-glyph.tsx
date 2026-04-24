import { memo, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';

export interface StatusGlyphProps {
  status: string;
  size?: number;
  className?: string;
}

interface GlyphConfig {
  glyph: string;
  color: string;
  label: string;
}

const config: Record<string, GlyphConfig> = {
  running: { glyph: '●', color: '#22C55E', label: 'running' },
  working: { glyph: '●', color: '#22C55E', label: 'working' },
  done: { glyph: '●', color: '#22C55E', label: 'done' },
  awaiting: { glyph: '▲', color: '#FFB800', label: 'awaiting' },
  needs_attention: { glyph: '▲', color: '#FFB800', label: 'needs attention' },
  setting_up: { glyph: '◐', color: '#FFB800', label: 'setting up' },
  error: { glyph: '✕', color: '#EF4444', label: 'error' },
  closed: { glyph: '○', color: '#6a6a6a', label: 'closed' },
  draft: { glyph: '○', color: '#6a6a6a', label: 'draft' },
};

const fallback: GlyphConfig = { glyph: '○', color: '#6a6a6a', label: 'unknown' };

export const StatusGlyph = memo(function StatusGlyph({
  status,
  size = 10,
  className,
}: StatusGlyphProps) {
  const cfg = config[status] || fallback;
  const style: CSSProperties = { color: cfg.color, fontSize: size, lineHeight: 1 };
  return (
    <span
      role="img"
      aria-label={cfg.label}
      data-status={status}
      data-glyph={cfg.glyph}
      className={cn('inline-flex items-center justify-center', className)}
      style={style}
    >
      {cfg.glyph}
    </span>
  );
});
