/**
 * packages/capabilities/src/capabilities/ask.ts
 *
 * METADATA for the `human` noun's single capability: `human.ask`. Pure zod +
 * plain types — no server internals, no handler.
 *
 * `human.ask` (MCP tool `ask_human`) lets an agent block on a free-text answer
 * from a human, rather than only being gated when it tries to WRITE something.
 * It reuses the exact same card + poll machinery as the write-capability gate
 * (`server/orchestrator/mcp/gate.ts`'s `onGatedInvoke`) — `always-ask` tier
 * means every call creates a card and waits; there is no "auto" mode for
 * asking a human a question, so a permission rule can never silence it (see
 * `packages/capabilities/src/capabilities/task.ts`'s `task.close`/`task.delete`
 * for the same tier used on destructive writes).
 *
 * `agent`-only: a human/UI caller typing at a terminal or clicking in the
 * dashboard has no reason to "ask a human" — they already are one.
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
  question: z.string().describe('The question to ask the human operator'),
});

export const HUMAN_CAPABILITY_META: CapabilityMeta[] = [
  {
    id: 'human.ask',
    summary:
      'Ask the human operator a question and block until they answer. Use when you are ' +
      'genuinely stuck or need a decision only a human can make — not for routine writes ' +
      '(those already gate on approval via their own tier).',
    mcp: 'ask_human',
    tier: 'always-ask',
    callers: ['agent'],
    input: askHumanInputSchema,
  },
];
