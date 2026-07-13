import type { ComponentType } from 'react';
import type { NavIcon } from '@/components/sidebar/glyphs';

export interface WorkflowUI {
  navLabel: string;
  icon: NavIcon;
  ListView?: ComponentType;
  /** Receives the item id from the route; fetches its own data. Omit to fall back to
   * DefaultDetailView, which needs `getItem` + `outputSchema` instead. */
  DetailView?: ComponentType<{ id: string }>;
  /** Required when DetailView is omitted — lets DefaultDetailView fetch + render generically. */
  getItem?: (id: string) => Promise<Record<string, unknown>>;
  outputSchema?: Record<string, unknown>;
}
