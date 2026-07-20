import type { Router } from 'express';
import type { JsonSchema } from '../services/output-contract.js';

export type SurfaceKind = 'session' | 'artifact' | 'feed';

export interface RunContext {
  repoPath: string;
  /** Validated against `config` with schema defaults applied. */
  config: unknown;
  /** Present for cron triggers. */
  scheduleId?: string;
  /** Present for github triggers. */
  event?: unknown;
}

export interface WorkflowType {
  kind: string;
  displayName: string;
  surfaces: SurfaceKind[];
  /** JSON Schema for schedule instance config — drives the /schedules form. */
  config?: JsonSchema;
  /** JSON Schema for this workflow's item shape — drives the client's schema-driven default
   * detail view. Absent for session-only workflows. */
  output?: JsonSchema;
  /** Bespoke Express router for workflows that keep their existing concrete endpoints. */
  apiRouter?: Router;
  /** How this workflow's runs are initiated — drives the trigger badge on the runs feed. */
  trigger?: { kind: 'cron' | 'github' | 'manual'; event?: string };
  /** Run entry point — cron poller, github pollers, and manual triggers converge here. */
  run?: (ctx: RunContext) => Promise<void>;
}
