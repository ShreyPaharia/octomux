import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function baseProps(size: number) {
  return {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

export function ChevronDownIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function CloseIcon({ size = 10, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function PlusIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/** Rounded square with an arrow — used for "terminal" empty states. */
export function TerminalRectIcon({ size = 48, strokeWidth = 1.5, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} strokeWidth={strokeWidth} {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="m7 8 4 4-4 4" />
      <path d="M13 16h4" />
    </svg>
  );
}
