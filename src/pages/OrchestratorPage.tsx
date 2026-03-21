import { lazy, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { OrchestratorCommandBar } from '@/components/OrchestratorCommandBar';
import { EmptyState } from '@/components/EmptyState';

const TerminalView = lazy(() =>
  import('@/components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

export default function OrchestratorPage() {
  const { running, loading, start, stop } = useOrchestratorContext();

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
            // ORCHESTRATOR
          </span>
          {running && <span className="h-2 w-2 animate-pulse bg-[#22C55E]" />}
        </div>
        {running && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive uppercase text-xs tracking-wider font-bold"
            onClick={stop}
          >
            STOP
          </Button>
        )}
      </div>

      {/* Terminal or empty state */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[#6a6a6a]">Loading...</div>
        ) : !running ? (
          <EmptyState
            icon={
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" x2="20" y1="19" y2="19" />
              </svg>
            }
            heading="ORCHESTRATOR STOPPED"
            subtext="Start the orchestrator to manage tasks autonomously"
            action={<Button onClick={start}>START ORCHESTRATOR</Button>}
            className="h-full"
          />
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-[#6a6a6a]">
                Loading terminal...
              </div>
            }
          >
            <TerminalView wsUrl="/ws/terminal/orchestrator" visible />
          </Suspense>
        )}
      </div>

      {/* Command bar at bottom */}
      {running && (
        <div className="border-t border-border">
          <OrchestratorCommandBar />
        </div>
      )}
    </div>
  );
}
