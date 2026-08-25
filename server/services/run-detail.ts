/**
 * server/services/run-detail.ts
 *
 * Polymorphic detail for a single `runs` row — the shape GET/POST /api/runs(/:id)
 * and the `run.emit` capability all return. Extracted into its own module because
 * BOTH the hand-written routes (server/routes/runs.ts) and the registry capability
 * (server/registry/capabilities/run.ts) need the exact same shape after collapsing
 * the loop/loop-group HTTP surface into the generic `runs` one (see routes/runs.ts's
 * module doc for the full design).
 */

import { getRunWithEffectiveStatus } from '../repositories/runs.js';
import type { RunRow } from '../repositories/runs.js';
import { getLoopRun, listIterationsForRun } from '../repositories/loop-runs.js';
import { getLoopGroupByRunId, listLoopRunsForGroup } from '../repositories/loop-groups.js';
import type { LoopRun, LoopIteration, LoopGroup } from '../types.js';
import { listTaskArtifacts, toArtifactEntry } from '../artifact-task.js';
import type { ArtifactEntry } from '@octomux/plugin-api';

export interface RunDetail extends RunRow {
  effective_status: string;
  /** Populated for ANY loop-backed run — workflow_kind 'loop', 'doc-drift',
   * 'prod-log-triage', or anything else that threaded a loop_run_id through
   * `insertRun` — not just workflow_kind==='loop'. */
  loop: (LoopRun & { iterations: LoopIteration[] }) | null;
  /** Populated only for workflow_kind==='loop-group', resolved via the
   * loop_groups.run_id reverse link (see `LoopGroup.run_id`'s doc). */
  loopGroup: (LoopGroup & { candidates: LoopRun[] }) | null;
  /** Files this run's task produced via `ctx.artifacts.write()` (SHR-269).
   *  Empty for a run with no task, or a task with no worktree. This is the
   *  ONE core wiring change that surfaces a plugin's artifacts in the run
   *  detail view — after it, a plugin needs zero further core changes to
   *  show up here. */
  artifacts: ArtifactEntry[];
}

export function getRunDetail(id: string): RunDetail | undefined {
  const run = getRunWithEffectiveStatus(id);
  if (!run) return undefined;

  let loop: RunDetail['loop'] = null;
  if (run.loop_run_id) {
    const loopRun = getLoopRun(run.loop_run_id);
    if (loopRun) loop = { ...loopRun, iterations: listIterationsForRun(loopRun.id) };
  }

  let loopGroup: RunDetail['loopGroup'] = null;
  if (run.workflow_kind === 'loop-group') {
    const group = getLoopGroupByRunId(run.id);
    if (group) loopGroup = { ...group, candidates: listLoopRunsForGroup(group.id) };
  }

  const artifacts = run.task_id
    ? listTaskArtifacts(run.task_id).map((r) => toArtifactEntry(run.task_id!, r))
    : [];

  return { ...run, loop, loopGroup, artifacts };
}
