/**
 * packages/capabilities/src/capabilities/learning.ts
 *
 * METADATA for the two `learning` routes that migrate cleanly onto the
 * registry: `learning.list` and `learning.delete`. Pure zod + plain types —
 * no server internals, no handlers. `server/registry/capabilities/learning.ts`
 * pairs each entry here with its (server-only) handler.
 *
 * ONLY two of the six `server/routes/learnings.ts` routes live here. The
 * other four (`POST /api/learnings`, `GET /api/learnings`,
 * `POST /api/learnings/:id/supersede`, `GET /api/learnings/digest`) are
 * gated by `requireBearerHookToken` (routes/hook-auth.ts) — a hard 401 on a
 * missing/invalid bearer token. `HttpProjection` (this package's types.ts)
 * has no field to express that, and the registry's own caller-resolution
 * (`resolveCallerFromRequest` in server/registry/projections/http.ts) does
 * not reject unauthenticated requests: an unrecognised caller falls through
 * to the fail-closed `'agent'` default and is then *authorized* (agent is
 * exactly the caller class these capabilities would need to serve). Moving
 * those four routes here would silently turn "401 without a valid agent
 * token" into "runs as an unauthenticated agent" — a real auth regression,
 * not a refactor. They stay hand-written in server/routes/learnings.ts.
 *
 * The two that migrate here (`GET /api/repos/:repoPath/learnings`,
 * `DELETE /api/learnings/:id`) carry no auth today, so `callers: ['ui',
 * 'human', 'agent']` (i.e. "any resolved caller") preserves that exactly —
 * `resolveCaller` always resolves to one of those three, so this is
 * behaviourally identical to "no auth check at all," never a *new*
 * restriction.
 *
 * Design doc: spec/surface-consolidation-and-centaur.md §5.1–5.3
 */

import { z } from 'zod';
import type { CapabilityMeta } from '../types.js';

// ─── learning.list ──────────────────────────────────────────────────────────

export const learningListInputSchema = z.object({
  repoPath: z.string().describe('URL-encoded absolute repo path'),
});

// ─── learning.delete ────────────────────────────────────────────────────────

export const learningDeleteInputSchema = z.object({
  id: z.string().describe('The learning id'),
});

// ─── Metadata ─────────────────────────────────────────────────────────────────

export const LEARNING_CAPABILITY_META: CapabilityMeta[] = [
  {
    id: 'learning.list',
    summary: "List a repo's review-lane learnings (dashboard Settings panel).",
    http: { method: 'get', path: '/api/repos/:repoPath/learnings' },
    tier: 'auto',
    callers: ['ui', 'human', 'agent'],
    input: learningListInputSchema,
  },
  {
    id: 'learning.delete',
    summary: 'Hard-delete a single learning.',
    // 204 + empty body matches the route it replaces (routes/learnings.ts).
    http: { method: 'delete', path: '/api/learnings/:id', status: 204 },
    tier: 'always-ask',
    callers: ['ui', 'human', 'agent'],
    input: learningDeleteInputSchema,
  },
];
