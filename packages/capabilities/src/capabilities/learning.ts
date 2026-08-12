/**
 * packages/capabilities/src/capabilities/learning.ts
 *
 * METADATA for all six `learning` routes. Pure zod + plain types — no server
 * internals, no handlers. `server/registry/capabilities/learning.ts` pairs
 * each entry here with its (server-only) handler.
 *
 * `learning.list` / `learning.delete` (`GET /api/repos/:repoPath/learnings`,
 * `DELETE /api/learnings/:id`) carry no auth today, so `callers: ['ui',
 * 'human', 'agent']` (i.e. "any resolved caller") preserves that exactly —
 * `resolveCaller` always resolves to one of those three, so this is
 * behaviourally identical to "no auth check at all," never a *new*
 * restriction.
 *
 * `learning.add` / `learning.recall` / `learning.supersede` / `learning.digest`
 * (`POST /api/learnings`, `GET /api/learnings`, `POST
 * /api/learnings/:id/supersede`, `GET /api/learnings/digest`) are the four
 * that were gated by `requireBearerHookToken` (routes/hook-auth.ts) — a hard
 * 401 on a missing/invalid bearer token — and could NOT migrate until
 * `HttpProjection` gained a way to express that (see `auth` in ./types.ts).
 * They now declare `http.auth: 'bearer-hook-token'`, which
 * `server/registry/projections/http.ts`'s `mountCapabilities` turns into the
 * SAME `requireBearerHookToken` middleware the hand-written routes used,
 * applied before the handler runs. `callers: ['agent']` only — the bearer
 * token IS the only caller class any of these four ever served; unlike
 * `learning.list`/`learning.delete` there is no "any resolved caller" case
 * to preserve here, because the pre-migration routes only ever ran for a
 * request that already proved it was an agent.
 *
 * Their input schemas are deliberately loose (fields typed `unknown`, not
 * `string`) rather than mirroring the field's real shape: the ORIGINAL
 * route's manual `typeof` checks and their exact error messages
 * (`'taskId is required'`, etc.) are part of the behaviour being preserved,
 * and they live in the server-only handler (this package cannot import
 * `badRequest`/`ServiceError` — no server internals). A strict zod schema
 * here would reject bad input with a generic `{error:'validation_failed',
 * issues:[...]}` body BEFORE the handler's own message-preserving checks
 * ever ran. The schema's only job is letting the merged
 * query/params/body object *reach* the handler unrejected.
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

// ─── learning.add ───────────────────────────────────────────────────────────
//
// Loose on purpose — see module doc. The handler (server-only) does the real
// `typeof`/`trim()` checks and throws the original error messages.

export const learningAddInputSchema = z.object({
  taskId: z.unknown().optional(),
  trigger: z.unknown().optional(),
  lesson: z.unknown().optional(),
  evidence: z.unknown().optional(),
  private: z.unknown().optional(),
});

// ─── learning.recall ────────────────────────────────────────────────────────

export const learningRecallInputSchema = z.object({
  taskId: z.unknown().optional(),
  query: z.unknown().optional(),
});

// ─── learning.supersede ─────────────────────────────────────────────────────
//
// `id` is a real path param — Express only calls this route when `:id`
// matched, so it is always a defined string, unlike the body fields below.

export const learningSupersedeInputSchema = z.object({
  id: z.string().describe('The learning id (path param)'),
  taskId: z.unknown().optional(),
  reason: z.unknown().optional(),
});

// ─── learning.digest ────────────────────────────────────────────────────────

export const learningDigestInputSchema = z.object({
  repo: z.unknown().optional(),
  sinceDays: z.unknown().optional(),
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
  {
    id: 'learning.add',
    summary: 'Record a durable learning for future runs on this repo (octomux learn).',
    // 201 matches the route it replaces. Bearer-gated: only a live agent's
    // hook token may write a learning.
    http: { method: 'post', path: '/api/learnings', status: 201, auth: 'bearer-hook-token' },
    tier: 'auto',
    callers: ['agent'],
    input: learningAddInputSchema,
  },
  {
    id: 'learning.recall',
    summary: 'Pull past learnings on this repo matching a topic (octomux recall).',
    http: { method: 'get', path: '/api/learnings', auth: 'bearer-hook-token' },
    tier: 'auto',
    callers: ['agent'],
    input: learningRecallInputSchema,
  },
  {
    id: 'learning.supersede',
    summary: 'Soft-supersede a learning that is no longer true (octomux unlearn).',
    http: { method: 'post', path: '/api/learnings/:id/supersede', auth: 'bearer-hook-token' },
    tier: 'auto',
    callers: ['agent'],
    input: learningSupersedeInputSchema,
  },
  {
    id: 'learning.digest',
    summary: 'Weekly digest: additions, removal candidates, benefit (octomux learnings-digest).',
    http: { method: 'get', path: '/api/learnings/digest', auth: 'bearer-hook-token' },
    tier: 'auto',
    callers: ['agent'],
    input: learningDigestInputSchema,
  },
];
