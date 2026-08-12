/**
 * server/registry/projections/mcp.ts
 *
 * MCP projection generator: turns registry capabilities into MCP tools for a
 * given caller. Supersedes the hand-written `COMMANDS.filter(c => c.mcp)` write
 * -tool loop in `orchestrator/mcp/server.ts` (that loop is left untouched here —
 * wiring this generator in is a later step).
 *
 * MCP exposure is deliberately narrower than CLI (design doc §5.3): every tool
 * costs context on every agent turn, so this generator only ever sees
 * capabilities returned by `listMcpCapabilities()`, which already filters on an
 * explicit `mcp:` name — it never widens that set. Target ~14 tools total.
 *
 * Visibility vs. invocation: a capability the caller may not invoke at all
 * (`authorize()` denies it) is not registered — not registered-then-rejected —
 * so the model never wastes a turn attempting a tool it cannot use. By
 * contrast, `ask` / `always-ask` tier capabilities the caller CAN invoke DO
 * register; the tier only changes what happens when the tool is actually
 * called (see `onGatedInvoke` below), not whether it shows up in the tool list.
 *
 * Design doc: docs/superpowers/specs/2026-08-12-surface-consolidation-and-centaur-design.md
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { childLogger } from '../../logger.js';
import { listMcpCapabilities, authorize } from '../index.js';
import type { Capability, CallerClass, CapabilityContext, PolicyTier } from '../types.js';

const logger = childLogger('registry/projections/mcp');

export interface RegisterCapabilityToolsOptions {
  /** Caller identity applied to every tool registered in this call. */
  caller: CallerClass;
  /**
   * Extension point for the future `ask_human` blocking-decision channel
   * (design doc §5.4). NOT implemented here — this is only the hook a later
   * change slots an approval step into, without touching registration.
   *
   * When set, called with the resolved invocation tier immediately before
   * `cap.handler` runs, for any call whose resolved tier is not `'auto'`
   * (i.e. an `agent` caller invoking an `ask` or `always-ask` capability —
   * `authorize()` always resolves `ui`/`human` callers to `'auto'`). Left
   * unset, non-`'auto'` tools simply run immediately, same as `'auto'` ones.
   */
  onGatedInvoke?: (cap: Capability, tier: PolicyTier, input: unknown) => Promise<void> | void;
  /**
   * Restrict registration to capabilities whose RESOLVED tier (post-
   * `authorize()`, so `ui`/`human` callers always resolve to `'auto'`) is in
   * this list. Omit to register every authorized capability.
   *
   * Exists because a worker session and the conductor are both `agent` callers
   * but must not get the same tools: a worker needs the read tier
   * (`task.list`/`task.get`) and must not get `task.create`/`close`/`delete`.
   * Tier is the honest axis for that split — it is already the field that says
   * "this one needs a human" — so filtering on it avoids a second, drifting
   * allowlist of tool names.
   */
  tiers?: PolicyTier[];
}

/**
 * Register every MCP-exposed capability `opts.caller` is authorized to invoke
 * as an MCP tool on `server`. Capabilities the caller may not invoke are
 * skipped entirely (see module doc above).
 */
export function registerCapabilityTools(
  server: McpServer,
  opts: RegisterCapabilityToolsOptions,
): void {
  let registered = 0;
  for (const cap of listMcpCapabilities()) {
    const decision = authorize(cap, opts.caller);
    if (!decision.allowed) {
      logger.debug(
        { operation: 'registerCapabilityTools', capability: cap.id, caller: opts.caller },
        'capability not authorized for caller — skipping MCP registration',
      );
      continue;
    }
    if (opts.tiers && !opts.tiers.includes(decision.tier)) {
      logger.debug(
        {
          operation: 'registerCapabilityTools',
          capability: cap.id,
          caller: opts.caller,
          tier: decision.tier,
        },
        'capability tier excluded by caller tier filter — skipping MCP registration',
      );
      continue;
    }
    registerOne(server, cap, decision.tier, opts);
    registered += 1;
  }
  logger.info(
    { operation: 'registerCapabilityTools', caller: opts.caller, registered },
    'registered MCP capability tools',
  );
}

function registerOne(
  server: McpServer,
  cap: Capability,
  tier: PolicyTier,
  opts: RegisterCapabilityToolsOptions,
): void {
  // Guaranteed by listMcpCapabilities()'s filter on cap.mcp.
  const name = cap.mcp as string;

  server.registerTool(
    name,
    { description: cap.summary, inputSchema: cap.input },
    async (input: unknown) => {
      try {
        if (tier !== 'auto' && opts.onGatedInvoke) {
          await opts.onGatedInvoke(cap, tier, input);
        }
        const ctx: CapabilityContext = { caller: opts.caller };
        const result = await cap.handler(input, ctx);
        // Matches the JSON-text content shape every tool in mcp/server.ts returns.
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        // Surface as isError text rather than a thrown protocol error (same
        // convention as mcp/server.ts's registerWriteTools errorResult), so the
        // caller can read and recover instead of hitting an opaque failure.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { operation: 'capabilityTool', capability: cap.id, mcp: name, err: message },
          'MCP capability tool failed — returning isError',
        );
        return {
          content: [{ type: 'text' as const, text: `${name} failed: ${message}` }],
          isError: true as const,
        };
      }
    },
  );
}
