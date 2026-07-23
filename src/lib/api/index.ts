/**
 * src/lib/api/index.ts
 *
 * Re-exports per-domain API namespaces (`taskApi`, `reviewApi`, `configApi`),
 * shared server types, and the orchestrator REST + WebSocket client. Each
 * feature surface should import only the namespace it needs from the concrete
 * module paths under `src/lib/api/`.
 */

export type { WorkflowStatus, RuntimeState, TaskExternalRef, TaskUpdate } from '@octomux/types';

export type { ReviewLearning } from '../../../server/types';

export * from './taskApi';
export * from './reviewApi';
export * from './configApi';
export * from './loopApi';
export * from './schedulesApi';

// Re-export the orchestrator REST + WebSocket client. It stays a separate,
// incompatibly-shaped surface (its `/ws/orchestrator/:id` socket is not folded
// into `/ws/events`), but lives under the same `@/lib/api` umbrella.
export * from '../orchestrator-api';
