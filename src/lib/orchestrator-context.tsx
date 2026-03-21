import { createContext, useContext, type ReactNode } from 'react';
import { useOrchestrator } from './hooks';

function useOrchestratorPanel() {
  const orchestrator = useOrchestrator();

  return { ...orchestrator };
}

export type OrchestratorState = ReturnType<typeof useOrchestratorPanel>;

const OrchestratorContext = createContext<OrchestratorState | null>(null);

export function OrchestratorProvider({ children }: { children: ReactNode }) {
  const state = useOrchestratorPanel();
  return <OrchestratorContext.Provider value={state}>{children}</OrchestratorContext.Provider>;
}

export function useOrchestratorContext(): OrchestratorState {
  const ctx = useContext(OrchestratorContext);
  if (!ctx) throw new Error('useOrchestratorContext must be used within OrchestratorProvider');
  return ctx;
}
