/**
 * src/lib/api/runApi.ts
 *
 * The generic `runs` API surface: unified feed, polymorphic detail, create
 * (loop / loop-group / launch-judge), and stop. Mirrors `server/routes/runs.ts`.
 * Replaces loopApi.ts + loopGroupApi.ts (both deleted) — collapsing the
 * loop/loop-group HTTP surface into one generic `runs` resource made two
 * separate frontend API modules redundant.
 */

import type { LoopRun, LoopIteration, LoopSpec, LoopGroup } from '../../../server/types';
import { request } from './client';

export type { LoopRun, LoopIteration, LoopSpec, LoopGroup };

/** A bare `runs` row, as returned by the list endpoint — thin and kind-agnostic,
 * with no loop/loop-group-specific fields (see server/routes/runs.ts's module doc). */
export interface RunRow {
  id: string;
  workflow_kind: string;
  trigger: string;
  schedule_id: string | null;
  task_id: string | null;
  chat_id: string | null;
  loop_run_id: string | null;
  status: string;
  effective_status: string;
  result_json: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

/** Polymorphic detail — what GET/POST /api/runs(/:id) return. Exactly one of
 * `loop`/`loopGroup` is populated, depending on the run's shape. */
export interface RunDetail extends RunRow {
  loop: (LoopRun & { iterations: LoopIteration[] }) | null;
  loopGroup: (LoopGroup & { candidates: LoopRun[] }) | null;
}

export const runApi = {
  listRuns: (kind?: string) =>
    request<{ runs: RunRow[] }>(`/runs${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
  getRun: (id: string) => request<RunDetail>(`/runs/${id}`),
  startLoop: (taskId: string, spec: LoopSpec) =>
    request<RunDetail>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowKind: 'loop', taskId, spec }),
    }),
  startLoopGroup: (data: { repoPath: string; baseBranch: string; spec: LoopSpec; n: number }) =>
    request<RunDetail>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowKind: 'loop-group', ...data }),
    }),
  stopRun: (id: string) => request<RunDetail>(`/runs/${id}/stop`, { method: 'POST' }),
  /** `runId` is the loop-group's own `runs.id` (the id its `POST /runs` response carried). */
  judgeLoopGroup: (runId: string) =>
    request<RunDetail>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowKind: 'judge', runId }),
    }),
};
