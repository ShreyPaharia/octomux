import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

const TOGGLE_ON_STYLE: CSSProperties = {
  background: 'linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%)',
  boxShadow: '0 0 12px rgba(59, 130, 246, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.35)',
};

const TOGGLE_OFF_STYLE: CSSProperties = {
  backgroundColor: 'rgba(255, 255, 255, 0.08)',
  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.14)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
};

export interface SwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        'focus-ring relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40',
        className,
      )}
      style={checked ? TOGGLE_ON_STYLE : TOGGLE_OFF_STYLE}
      onClick={() => onChange(!checked)}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
}
