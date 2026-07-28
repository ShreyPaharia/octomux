import { Skeleton } from '@/components/ui/skeleton';

/** Placeholder that matches the rough shape of the TaskDetail page header + body. */
export function TaskDetailSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading task…">
      {/* Header bar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-glass-edge px-4 py-2.5">
        <Skeleton className="h-5 w-5 rounded-full" />
        <Skeleton className="h-4 w-48" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-7 w-16 rounded-md" />
          <Skeleton className="h-7 w-20 rounded-md" />
        </div>
      </div>

      {/* Meta strip */}
      <div className="flex shrink-0 items-center gap-4 border-b border-glass-edge px-4 py-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-32" />
      </div>

      {/* Body — terminal-shaped area */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <Skeleton className="h-8 w-full rounded-md" />
        <Skeleton className="h-full w-full flex-1 rounded-md" style={{ minHeight: '200px' }} />
      </div>
    </div>
  );
}
