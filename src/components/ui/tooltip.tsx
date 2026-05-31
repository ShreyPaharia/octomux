import { useId, useState, type ReactNode } from 'react';

interface InfoTooltipProps {
  /** Explanatory content shown in the tooltip bubble. */
  content: ReactNode;
  /** Accessible label for the trigger button. */
  label?: string;
  className?: string;
}

/**
 * A small, dependency-free tooltip: an info trigger that reveals an explanatory
 * bubble on hover AND keyboard focus. Use for short help text where a bare `title`
 * attribute reads poorly. The bubble is `role="tooltip"` and linked to the trigger
 * via `aria-describedby` while visible.
 */
export function InfoTooltip({ content, label = 'More information', className }: InfoTooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className="focus-ring flex size-4 items-center justify-center rounded-full border border-glass-edge text-[10px] font-semibold leading-none text-[#8a8a8a] transition-colors hover:border-[#60a5fa] hover:text-[#60a5fa]"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="absolute left-1/2 top-full z-50 mt-1.5 w-64 -translate-x-1/2 rounded-md border border-glass-edge bg-popover px-3 py-2 text-xs leading-relaxed text-[#d4d4dc] shadow-lg"
        >
          {content}
        </span>
      )}
    </span>
  );
}
