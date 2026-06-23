/**
 * src/lib/api/index.ts
 *
 * Reassembles the per-domain namespaces (`taskApi`, `reviewApi`, `configApi`)
 * into the single flat `api` object that the SPA has always consumed, and
 * re-exports every namespace type plus the orchestrator client. Each feature
 * surface can import only the namespace it needs (`taskApi` / `reviewApi` /
 * `configApi`), while legacy consumers keep using the flat `api` via the
 * `src/lib/api.ts` shim.
 */

export type {
  WorkflowStatus,
  RuntimeState,
  TaskExternalRef,
  TaskUpdate,
  ReviewLearning,
} from '../../../server/types';

export * from './taskApi';
export * from './reviewApi';
export * from './configApi';

// Re-export the orchestrator REST + WebSocket client. It stays a separate,
// incompatibly-shaped surface (its `/ws/orchestrator/:id` socket is not folded
// into `/ws/events`), but lives under the same `@/lib/api` umbrella.
export * from '../orchestrator-api';

import { taskApi } from './taskApi';
import { reviewApi } from './reviewApi';
import { configApi } from './configApi';

export const api = {
  ...taskApi,
  ...reviewApi,
  ...configApi,
};
