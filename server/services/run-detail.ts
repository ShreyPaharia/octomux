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

export interface RunDetail extends RunRow {
  effective_status: string;
  /** Populated for ANY loop-backed run — workflow_kind 'loop', 'doc-drift',
   * 'prod-log-triage', or anything else that threaded a loop_run_id through
   * `insertRun` — not just workflow_kind==='loop'. */
  loop: (LoopRun & { iterations: LoopIteration[] }) | null;
  /** Populated only for workflow_kind==='loop-group', resolved via the
   * loop_groups.run_id reverse link (see `LoopGroup.run_id`'s doc). */
  loopGroup: (LoopGroup & { candidates: LoopRun[] }) | null;
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

  return { ...run, loop, loopGroup };
}
