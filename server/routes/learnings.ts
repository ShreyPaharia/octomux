import {
  laneFor,
  searchForRead,
  searchShared,
  touchLearning,
} from '../repositories/agent-learnings.js';
import type { AgentLearning } from '../types.js';
import { getTask } from '../repositories/tasks.js';
import { notFound } from '../services/errors.js';

// The PR-review learning lane in the shared agent_learnings store (folded in
// from the old standalone review_learnings table — see spec/agent-learnings-store.md Task 9).
// Exported: server/registry/capabilities/learning.ts's learning.list handler
// (the migrated GET /api/repos/:repoPath/learnings) reuses these verbatim.
export const REVIEW_LANE = 'review';
export const REVIEW_LIST_LIMIT = 50;

// All six routes that used to live here now live in
// server/registry/capabilities/learning.ts as capabilities:
//   - learning.list / learning.delete (GET /api/repos/:repoPath/learnings,
//     DELETE /api/learnings/:id) — unauthenticated before and after.
//   - learning.add / learning.recall / learning.supersede / learning.digest
//     (POST /api/learnings, GET /api/learnings, POST
//     /api/learnings/:id/supersede, GET /api/learnings/digest) — gated by
//     requireBearerHookToken (routes/hook-auth.ts) before, and still gated by
//     the SAME middleware now via HttpProjection's `auth: 'bearer-hook-token'`
//     (see server/registry/projections/http.ts and
//     packages/capabilities/src/capabilities/learning.ts for the mechanism).
//
// `recallLearnings` below stays here (not moved into the capability handler)
// because the search_learnings MCP tool (server/orchestrator/mcp/read.ts)
// also calls it directly, in-process — both learning.recall's handler and
// that MCP tool import it from this module.

/**
 * Recall learnings matching `query`, shared across `learning.recall`'s handler
 * (server/registry/capabilities/learning.ts, the migrated bearer-gated
 * `GET /api/learnings`) and the `search_learnings` MCP tool
 * (server/orchestrator/mcp/read.ts) — previously two independent
 * implementations that behaved differently (one lane-aware + usage-tracking,
 * the other shared-lane-only and silent). Now one function both call
 * in-process:
 *
 *   - `taskId` given (the HTTP route, always): resolves the task's own lane
 *     via `laneFor`, searches shared + that lane via `searchForRead`, and
 *     bumps `usage_count` on every returned row via `touchLearning` — exactly
 *     what the route did inline before.
 *   - `taskId` omitted (the MCP tool, which has no task context — it's the
 *     conductor's cross-task search, not a worker's): searches the shared
 *     lane only via `searchShared`, no usage bump — exactly what
 *     `handleSearchLearnings` did inline before.
 */
export function recallLearnings(input: {
  taskId?: string;
  query: string;
  repo?: string;
}): AgentLearning[] {
  if (input.taskId) {
    const task = getTask(input.taskId);
    if (!task) throw notFound('Task not found');
    const rows = searchForRead(task.repo_path, laneFor(task), input.query);
    for (const r of rows) touchLearning(r.id);
    return rows;
  }
  return searchShared(input.query, input.repo ? { repo: input.repo } : {});
}
