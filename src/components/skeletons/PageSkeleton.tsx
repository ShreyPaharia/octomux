import { Skeleton } from '@/components/ui/skeleton';

/** Generic single-column page skeleton for most non-terminal pages. */
export function PageSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 p-6" aria-busy="true" aria-label="Loading…">
      {/* Page title */}
      <Skeleton className="h-7 w-40" />
      {/* Toolbar row */}
      <div className="flex gap-2">
        <Skeleton className="h-8 w-24 rounded-md" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      {/* Content cards */}
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}
