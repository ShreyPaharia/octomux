/**
 * src/lib/api/workflowsApi.ts
 *
 * Workflows control-plane API surface: the registry listing (with trigger +
 * run count) and per-workflow run history. Mirrors `server/routes/workflow-runs.ts`.
 */

import { request } from './client';

export interface WorkflowTrigger {
  kind: 'cron' | 'github' | 'manual';
  event?: string;
}

export interface WorkflowRow {
  kind: string;
  displayName: string;
  surfaces: string[];
  trigger: WorkflowTrigger | null;
  /** JSON Schema for this workflow's result shape, or null if it has none. */
  output: Record<string, unknown> | null;
  runCount: number;
}

export interface WorkflowRunRow {
  id: string;
  workflow_kind: string;
  trigger: string;
  status: string;
  effective_status: string;
  schedule_id: string | null;
  task_id: string | null;
  loop_run_id: string | null;
  chat_id: string | null;
  started_at: string;
  /** Structured result from a headless session run (runAgentSession), JSON-stringified. */
  result_json?: string | null;
}

export const workflowsApi = {
  listWorkflows: () => request<{ workflows: WorkflowRow[] }>('/workflows'),
  getWorkflowRuns: (kind: string) => request<{ runs: WorkflowRunRow[] }>(`/workflows/${kind}/runs`),
  listAllRuns: () => request<{ runs: WorkflowRunRow[] }>('/runs'),
};
