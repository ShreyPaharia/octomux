import { useEffect, lazy, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { EmptyState } from './EmptyState';

const TerminalView = lazy(() =>
  import('@/components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

/** Header toggle button — renders in AppHeader */
export function OrchestratorToggle({
  isOpen,
  running,
  toggle,
}: {
  isOpen: boolean;
  running: boolean;
  toggle: () => void;
}) {
  return (
    <Button
      variant={isOpen ? 'secondary' : 'ghost'}
      size="sm"
      onClick={toggle}
      title="Toggle orchestrator"
      className="relative gap-1.5"
    >
      <TerminalIcon className="h-4 w-4" />
      <span className="text-xs hidden sm:inline">Orchestrator</span>
      {running && (
        <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
      )}
    </Button>
  );
}

/** Modal overlay for orchestrator terminal */
export function OrchestratorModal() {
  const { isOpen, close, running, loading, start, stop } = useOrchestratorContext();

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, close]);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-200 ${
        isOpen ? 'visible opacity-100' : 'invisible opacity-0 pointer-events-none'
      }`}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={close} />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="orchestrator-title"
        className={`relative z-10 flex h-[80vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl transition-transform duration-200 ${
          isOpen ? 'scale-100' : 'scale-95'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                running ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/30'
              }`}
            />
            <span id="orchestrator-title" className="text-sm font-medium">
              Orchestrator
            </span>
          </div>
          <div className="flex items-center gap-1">
            {running && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={stop}>
                Stop
              </Button>
            )}
            <button
              onClick={close}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <XIcon />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading...
            </div>
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
              heading="Orchestrator not running"
              subtext="Start the orchestrator to manage task queues"
              action={<Button onClick={start}>Start Orchestrator</Button>}
              className="h-full"
            />
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading terminal...
                </div>
              }
            >
              <TerminalView wsUrl="/ws/terminal/orchestrator" visible={isOpen} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
