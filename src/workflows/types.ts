import type { ComponentType } from 'react';

export interface WorkflowUI {
  navLabel: string;
  icon: ComponentType<{ className?: string }>;
  ListView?: ComponentType;
  /** Receives the item id from the route; fetches its own data. Omit to fall back to
   * DefaultDetailView, which needs `getItem` + `outputSchema` instead. */
  DetailView?: ComponentType<{ id: string }>;
  /** Required when DetailView is omitted — lets DefaultDetailView fetch + render generically. */
  getItem?: (id: string) => Promise<Record<string, unknown>>;
  outputSchema?: Record<string, unknown>;
}
