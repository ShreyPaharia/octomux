/**
 * server/registry/capabilities/human.ts
 *
 * Handler for `human.ask` (MCP tool `ask_human`). Pairs
 * `HUMAN_CAPABILITY_META` (packages/capabilities/src/capabilities/ask.ts)
 * with its server-only handler, mirroring `registerTaskCapabilities` /
 * `registerLearningCapabilities`.
 *
 * `human.ask` is `always-ask` tier, so on every real call
 * `registerCapabilityTools` (server/registry/projections/mcp.ts) runs
 * `onGatedInvoke` (server/orchestrator/mcp/gate.ts) BEFORE this handler —
 * and `onGatedInvoke` resolves with `{ answer }` for this capability, which
 * SHORT-CIRCUITS the tool call: this handler never actually runs in that
 * path. It only runs when the capability gate's kill switch
 * (`OCTOMUX_CAPABILITY_GATE_ENABLED=false`) is off, in which case
 * `onGatedInvoke` returns `undefined` (bypass) and this handler is reached
 * directly — at that point gating is off entirely, so there is no one to
 * route the question to, and it answers honestly rather than hanging or
 * throwing.
 */

import { HUMAN_CAPABILITY_META, askHumanInputSchema } from '@octomux/capabilities';
import type { CapabilityMeta } from '@octomux/capabilities';
import { z } from 'zod';
import { defineCapability } from '../index.js';

function findMeta<TInput>(id: string, _schema: z.ZodType<TInput>): CapabilityMeta<TInput> {
  const meta = HUMAN_CAPABILITY_META.find((m) => m.id === id);
  if (!meta) throw new Error(`registry: missing capability metadata for '${id}'`);
  return meta as CapabilityMeta<TInput>;
}

async function askHumanHandler(_input: z.infer<typeof askHumanInputSchema>) {
  // Reached only when the capability gate kill switch is off — see module doc.
  return {
    answer: null,
    note:
      'capability gating is disabled (OCTOMUX_CAPABILITY_GATE_ENABLED=false) — ' +
      'no one was asked',
  };
}

export function registerHumanCapabilities(): void {
  defineCapability({
    ...findMeta('human.ask', askHumanInputSchema),
    handler: askHumanHandler,
  });
}
