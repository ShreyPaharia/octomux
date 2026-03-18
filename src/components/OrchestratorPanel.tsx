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

export function useOrchestratorPanel() {
  const [isOpen, setIsOpen] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true');
  const orchestrator = useOrchestrator();

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  return { isOpen, open, close, toggle, ...orchestrator };
}

export type OrchestratorPanelState = ReturnType<typeof useOrchestratorPanel>;

/** Header toggle button — renders in the Dashboard toolbar */
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
      title="Toggle orchestrator panel"
      className="relative gap-1.5 hidden md:inline-flex"
    >
      <TerminalIcon className="h-4 w-4" />
      <span className="text-xs">Orchestrator</span>
      {running && (
        <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
      )}
    </Button>
  );
}

/** Side panel — only renders content when open */
export function OrchestratorPanel({ state }: { state: OrchestratorPanelState }) {
  const { isOpen, close, running, loading, start, stop } = state;
  const isMobile = useIsMobile();

  if (!isOpen) return null;

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
            onClick={close}
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
        <div className="fixed inset-0 z-40 bg-black/50" onClick={close} />
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
