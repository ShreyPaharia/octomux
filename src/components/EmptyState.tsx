// src/components/EmptyState.tsx
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  heading: string;
  subtext?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, heading, subtext, action, className = '' }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center py-16 animate-in fade-in duration-300 ${className}`}
    >
      <div className="text-[#6a6a6a]">{icon}</div>
      <h3 className="mt-4 text-lg font-display font-bold uppercase tracking-wider">{heading}</h3>
      {subtext && <p className="mt-1 text-sm text-[#6a6a6a]">{subtext}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
