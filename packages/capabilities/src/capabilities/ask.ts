/**
 * packages/capabilities/src/capabilities/ask.ts
 *
 * METADATA for the `human` noun's single capability: `human.ask`. Pure zod +
 * plain types — no server internals, no handler.
 *
 * `human.ask` (MCP tool `ask_human`) lets an agent block on a free-text answer
 * from its session's owner, rather than only being gated when it tries to
 * WRITE something. It reuses the exact same card + poll machinery as the
 * write-capability gate (`server/orchestrator/mcp/gate.ts`'s
 * `onGatedInvoke`) — `always-ask` tier means every call creates a card and
 * waits; there is no "auto" mode for asking a question, so a permission rule
 * can never silence it (see `packages/capabilities/src/capabilities/task.ts`'s
 * `task.close`/`task.delete` for the same tier used on destructive writes).
 *
 * "Session's owner", not "a human", deliberately: for the conductor that IS a
 * human at the dashboard, but for a worker the question routes to the
 * conductor supervising it — `managed_tasks` (task → conversation) is the
 * routing table, not a workaround for finding a person (see
 * `server/hooks.ts`'s `/gate-card` doc). The worker doesn't need to know who
 * or what is on the other end, only that it blocks until an answer comes
 * back — which today is still always a human, since resolving a card is only
 * wired up from the dashboard (no conductor-side MCP answer tool exists yet;
 * that's a separate capability for a later change, not a redesign of this
 * one).
 *
 * `agent`/`worker`-only: a human/UI caller typing at a terminal or clicking in
 * the dashboard has no reason to invoke this — they already are the person
 * being asked. Workers (task sessions, as distinct from the orchestrator
 * conductor) are included because this is precisely the primitive a worker
 * needs when it is stuck on a design question mid-task — see CallerClass's
 * doc in ../types.ts.
 *
 * No `http`/`cli` projection: this tool only makes sense inside an agent's own
 * turn, blocking on an answer before it can proceed — there is no synchronous
 * REST/CLI caller that would want the same blocking semantics.
 *
 * Design doc: docs/superpowers/specs/2026-08-12-surface-consolidation-and-centaur-design.md
 */

import { z } from 'zod';
import type { CapabilityMeta } from '../types.js';

export const askHumanInputSchema = z.object({
  question: z.string().describe("The question to ask your session's owner"),
});

export const HUMAN_CAPABILITY_META: CapabilityMeta[] = [
  {
    id: 'human.ask',
    summary:
      "Ask a question and block until your session's owner answers — the human operator " +
      'you report to directly, or (for a worker task) the conductor supervising this task. ' +
      'Use when you are genuinely stuck or need a decision you cannot make yourself — not ' +
      'for routine writes (those already gate on approval via their own tier).',
    mcp: 'ask_human',
    tier: 'always-ask',
    callers: ['agent', 'worker'],
    input: askHumanInputSchema,
  },
];
