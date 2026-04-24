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

export function PullRequestIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 15.5V9a3 3 0 0 0-3-3h-3" />
      <path d="m15 9-3-3 3-3" />
    </svg>
  );
}

export function CheckIcon({ size = 12, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="M20 6 9 17l-5-5" />
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

export function ActivityIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

export function TriangleAlertIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function CloudOffIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="M2 2l20 20" />
      <path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193" />
      <path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07" />
    </svg>
  );
}

export function LayoutGridIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </svg>
  );
}

export function SearchIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function RocketIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

export function CircleCheckIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg {...baseProps(size)} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
