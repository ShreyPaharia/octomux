import { lazy, Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { OrchestratorCommandBar } from '@/components/OrchestratorCommandBar';

const TerminalView = lazy(() =>
  import('@/components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

export default function OrchestratorPage() {
  const { running, loading, restart } = useOrchestratorContext();
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
            // ORCHESTRATOR
          </span>
          {running && <span className="h-2 w-2 animate-pulse bg-[#22C55E]" />}
          <div className="relative">
            <button
              onClick={() => setShowHelp(!showHelp)}
              className="flex h-5 w-5 items-center justify-center text-[10px] text-[#6a6a6a] hover:text-white"
              aria-label="Orchestrator help"
            >
              ?
            </button>
            {showHelp && (
              <div className="absolute left-0 top-7 z-50 w-80 border border-[#2f2f2f] bg-[#1a1a1a] p-4 text-xs shadow-lg">
                <p className="mb-2 font-bold text-white">What can the orchestrator do?</p>
                <ul className="mb-3 space-y-1 text-[#8a8a8a]">
                  <li>Create tasks to dispatch autonomous Claude Code agents</li>
                  <li>Monitor running tasks and their agents</li>
                  <li>Close or resume tasks as needed</li>
                  <li>Add agents to running tasks for parallel work</li>
                  <li>Generate PR previews and create PRs for completed work</li>
                  <li>Check status and troubleshoot errors</li>
                </ul>
                <p className="mb-1 font-bold text-white">Try something like:</p>
                <ul className="space-y-1 text-[#8a8a8a]">
                  <li>"Create a task to fix the login bug in the auth service"</li>
                  <li>"Show me all running tasks"</li>
                  <li>"What is the status of task abc123?"</li>
                </ul>
              </div>
            )}
          </div>
        </div>
        {running && (
          <Button
            variant="ghost"
            size="sm"
            className="uppercase text-xs tracking-wider font-bold text-[#8a8a8a]"
            onClick={restart}
          >
            RESTART
          </Button>
        )}
      </div>

      {/* Terminal or empty state */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[#6a6a6a]">Loading...</div>
        ) : !running ? (
          <div className="flex h-full items-center justify-center text-[#6a6a6a]">
            Starting orchestrator...
          </div>
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
