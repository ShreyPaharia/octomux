import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useOrchestrator } from './hooks';

export type OrchestratorState = ReturnType<typeof useOrchestrator>;

const OrchestratorContext = createContext<OrchestratorState | null>(null);

export function OrchestratorProvider({ children }: { children: ReactNode }) {
  const { running, loading, error, start, stop, restart, refresh } = useOrchestrator();
  // Memoize so consumers (UniversalSidebar, OrchestratorPage, etc.) don't
  // re-render every time this provider renders — only when a field changes.
  const value = useMemo<OrchestratorState>(
    () => ({ running, loading, error, start, stop, restart, refresh }),
    [running, loading, error, start, stop, restart, refresh],
  );
  return <OrchestratorContext.Provider value={value}>{children}</OrchestratorContext.Provider>;
}

export function useOrchestratorContext(): OrchestratorState {
  const ctx = useContext(OrchestratorContext);
  if (!ctx) throw new Error('useOrchestratorContext must be used within OrchestratorProvider');
  return ctx;
}
