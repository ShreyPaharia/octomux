import type { Router } from 'express';
import type { JsonSchema } from '../services/output-contract.js';

export type SurfaceKind = 'session' | 'artifact' | 'feed';

/** Minimal descriptor — P4 only needs `kind`/`displayName`/`surfaces`/`output` to back the
 * registry and the schema-driven default renderer. `trigger`/`run`/`sinks` stay declarative
 * placeholders documented in spec/workflow-framework.md §4 for workflows whose lifecycle is
 * fully owned by the framework; loops and pr-extract keep their own bespoke routes via
 * `apiRouter` during this migration, matching how reviews will migrate later. */
export interface WorkflowType {
  kind: string;
  displayName: string;
  surfaces: SurfaceKind[];
  /** JSON Schema for this workflow's item shape — drives the client's schema-driven default
   * detail view. Absent for session-only workflows. */
  output?: JsonSchema;
  /** Bespoke Express router for workflows that keep their existing concrete endpoints
   * (loops: /api/loops, pr-extract: /api/pr-extracts) rather than a generic API surface. */
  apiRouter?: Router;
  /** How this workflow's runs are initiated — drives the trigger badge on the
   * Workflows control-plane page. */
  trigger?: { kind: 'cron' | 'github' | 'manual'; event?: string };
}
