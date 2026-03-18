import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { useOrchestrator } from './hooks';

function useOrchestratorPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const orchestrator = useOrchestrator();

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  return { isOpen, open, close, toggle, ...orchestrator };
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
