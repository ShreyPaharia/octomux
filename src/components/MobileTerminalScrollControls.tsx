import type { ReactNode } from 'react';

import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { cn } from '@/lib/utils';

export interface MobileTerminalScrollControlsProps {
  onScrollOlder: () => void;
  onScrollNewer: () => void;
  onScrollToBottom: () => void;
  className?: string;
}

function ScrollButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="bg-glass-l2 glass-blur-l1 flex size-11 items-center justify-center rounded-lg border border-glass-edge text-foreground active:bg-glass-l3"
    >
      {children}
    </button>
  );
}

/** Tap targets for scrolling agent session output when touch-drag is unreliable on mobile. */
export function MobileTerminalScrollControls({
  onScrollOlder,
  onScrollNewer,
  onScrollToBottom,
  className,
}: MobileTerminalScrollControlsProps) {
  return (
    <div
      data-testid="mobile-terminal-scroll-controls"
      role="toolbar"
      aria-label="Terminal scroll"
      className={cn('pointer-events-auto flex items-center gap-1.5', className)}
    >
      <ScrollButton label="Older output" onClick={onScrollOlder}>
        <ChevronUpIcon size={20} aria-hidden />
      </ScrollButton>
      <ScrollButton label="Newer output" onClick={onScrollNewer}>
        <ChevronDownIcon size={20} aria-hidden />
      </ScrollButton>
      <button
        type="button"
        aria-label="Jump to latest output"
        title="Jump to latest"
        onClick={onScrollToBottom}
        className="bg-glass-l2 glass-blur-l1 h-11 rounded-lg border border-glass-edge px-3 text-[11px] font-semibold text-foreground active:bg-glass-l3"
      >
        Latest
      </button>
    </div>
  );
}
