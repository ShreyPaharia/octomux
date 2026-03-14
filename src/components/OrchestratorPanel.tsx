import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { useOrchestrator } from '@/lib/hooks';

const TerminalView = lazy(() =>
  import('@/components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

const STORAGE_KEY = 'orchestrator-panel-open';

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}

export function OrchestratorPanel() {
  const [isOpen, setIsOpen] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true');
  const { running, loading, start, stop } = useOrchestrator();
  const isMobile = useIsMobile();

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  const closePanel = useCallback(() => setIsOpen(false), []);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className={`hidden md:block fixed right-0 top-1/2 -translate-y-1/2 z-50 rounded-l-md border-2 border-r-0 px-1.5 py-3 text-xs font-medium transition-colors ${
          running
            ? 'border-emerald-500/50 bg-card/90 text-foreground shadow-[0_0_8px_rgba(16,185,129,0.2)]'
            : 'border-border bg-card/80 text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
        style={{ writingMode: 'vertical-rl' }}
      >
        Orchestrator
        {running && (
          <span className="ml-1 inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        )}
      </button>
    );
  }

  const panelContent = (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${running ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/30'}`}
          />
          <span className="text-sm font-medium">Orchestrator</span>
        </div>
        <div className="flex items-center gap-1">
          {running && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={stop}>
              Stop
            </Button>
          )}
          <button
            onClick={closePanel}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
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
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Loading...
          </div>
        ) : !running ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <p className="text-sm text-muted-foreground">Orchestrator is not running</p>
            <Button onClick={start}>Start Orchestrator</Button>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Loading terminal...
              </div>
            }
          >
            <TerminalView wsUrl="/ws/terminal/orchestrator" />
          </Suspense>
        )}
      </div>
    </>
  );

  // Mobile: full-width overlay
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        <div className="fixed inset-0 z-40 bg-black/50" onClick={closePanel} />
        {/* Slide-out panel */}
        <div className="fixed inset-y-0 right-0 z-50 w-full bg-card flex flex-col animate-in slide-in-from-right duration-200">
          {panelContent}
        </div>
      </>
    );
  }

  // Desktop: inline panel with responsive width
  return (
    <div className="w-[500px] max-[1279px]:w-[400px] max-[1023px]:w-[350px] shrink-0 border-l border-border bg-card flex flex-col">
      {panelContent}
    </div>
  );
}
