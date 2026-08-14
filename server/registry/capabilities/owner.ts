/**
 * server/registry/capabilities/owner.ts
 *
 * Handler for `owner.ask` (MCP tool `ask_owner`). Pairs
 * `OWNER_CAPABILITY_META` (packages/capabilities/src/capabilities/ask.ts)
 * with its server-only handler, mirroring `registerTaskCapabilities` /
 * `registerLearningCapabilities`.
 *
 * `owner.ask` is `always-ask` tier, so on every real call
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

import { OWNER_CAPABILITY_META, askOwnerInputSchema } from '@octomux/capabilities';
import type { CapabilityMeta } from '@octomux/capabilities';
import { z } from 'zod';
import { defineCapability } from '../index.js';

function findMeta<TInput>(id: string, _schema: z.ZodType<TInput>): CapabilityMeta<TInput> {
  const meta = OWNER_CAPABILITY_META.find((m) => m.id === id);
  if (!meta) throw new Error(`registry: missing capability metadata for '${id}'`);
  return meta as CapabilityMeta<TInput>;
}

async function askOwnerHandler(_input: z.infer<typeof askOwnerInputSchema>) {
  // Reached only when the capability gate kill switch is off — see module doc.
  return {
    answer: null,
    note:
      'capability gating is disabled (OCTOMUX_CAPABILITY_GATE_ENABLED=false) — ' +
      'no one was asked',
  };
}

export function registerOwnerCapabilities(): void {
  defineCapability({
    ...findMeta('owner.ask', askOwnerInputSchema),
    handler: askOwnerHandler,
  });
}
