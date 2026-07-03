import type { ReactNode } from 'react';
import { GlassButton } from '@/components/ui/glass-button';

export interface DataSectionProps {
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  isEmpty: boolean;
  empty?: ReactNode;
  skeletonRows?: number;
  children: ReactNode;
}

export function DataSection({
  loading,
  error,
  onRetry,
  isEmpty,
  empty,
  skeletonRows = 3,
  children,
}: DataSectionProps) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: skeletonRows }, (_, i) => (
          <div key={i} className="h-12 animate-pulse border border-glass-edge bg-glass-l1" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 border border-red-400/30 bg-red-400/5 px-4 py-3">
        <span className="text-sm text-red-400">{error}</span>
        {onRetry && (
          <GlassButton variant="link" size="inline" onClick={onRetry}>
            Retry
          </GlassButton>
        )}
      </div>
    );
  }

  if (isEmpty) {
    return <>{empty}</>;
  }

  return <>{children}</>;
}
