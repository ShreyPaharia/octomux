/**
 * packages/capabilities/src/capabilities/run.ts
 *
 * METADATA for the `run` noun's one capability: `run.emit`, the bearer-gated
 * agent callback that used to be two separate hand-written routes —
 * `POST /api/loops/:runId/emit` and `POST /api/loop-groups/:id/judge/emit`
 * (server/routes/loops.ts, server/routes/loop-groups.ts, both deleted). Both
 * collapsed into `POST /api/runs/:id/emit`: `server/registry/capabilities/run.ts`
 * discriminates the body shape by the target run's `workflow_kind` at request
 * time (loop-backed → `{status, reason}`, `loop-group` → `{winnerLoopRunId,
 * rationale}`), so ONE capability row covers both — see that module's doc for why.
 *
 * Input schema is deliberately loose (fields typed `unknown`), same reasoning
 * as `learning.add`/`learning.recall`/etc. in ./learning.ts: the ORIGINAL
 * routes' manual `typeof` checks and their exact error messages are part of
 * the behaviour being preserved, and they live in the server-only handler
 * (this package cannot import `badRequest`/`ServiceError`).
 *
 * Design doc: spec/surface-consolidation-and-centaur.md §5.1–5.3 (loop/loop-group collapse)
 */

import { z } from 'zod';
import type { CapabilityMeta } from '../types.js';

export const runEmitInputSchema = z.object({
  id: z.string().describe('The run id (path param) — a `runs.id`, not a loop_runs/loop_groups id'),
  // Loop-backed shape.
  status: z.unknown().optional(),
  reason: z.unknown().optional(),
  // loop-group (judge) shape.
  winnerLoopRunId: z.unknown().optional(),
  rationale: z.unknown().optional(),
});

export const RUN_CAPABILITY_META: CapabilityMeta[] = [
  {
    id: 'run.emit',
    summary:
      'Agent callback reporting a loop iteration status or a best-of-N judge verdict ' +
      '(octomux emit / octomux judge-emit).',
    // Bearer-gated: only a live agent's hook token may report a run's status.
    http: { method: 'post', path: '/api/runs/:id/emit', auth: 'bearer-hook-token' },
    tier: 'auto',
    callers: ['agent'],
    input: runEmitInputSchema,
  },
];
