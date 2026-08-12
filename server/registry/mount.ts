/**
 * server/registry/mount.ts
 *
 * The single composition point wiring the capability registry to every
 * transport. Callers (server/api.ts, server/orchestrator/mcp/server.ts,
 * cli/src/index.ts) call one of the three functions below instead of having
 * to remember the full list of capability/exemption modules to import and
 * the three projection generators to invoke.
 *
 * Design doc: docs/superpowers/specs/2026-08-12-surface-consolidation-and-centaur-design.md
 */

import express from 'express';
import type { Express } from 'express';
import type { Command } from 'commander';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { childLogger } from '../logger.js';
import type { CallerClass } from './types.js';
import { mountCapabilities } from './projections/http.js';
import { registerCapabilityTools } from './projections/mcp.js';
import { registerCapabilityCommands } from './projections/cli.js';

const logger = childLogger('registry/mount');

let installed = false;

/**
 * Registers every capability and exemption module. Idempotent — each of the
 * three transport entry points below calls this first, and none of them
 * needs to coordinate with the others about who runs it.
 *
 * Guarded by a module-level flag rather than relying on `defineCapability`'s
 * own duplicate-id guard: the latter would still re-run every capability
 * module's top-level registration work on a second call (wasteful, and a
 * throw on the very first `defineCapability` inside it), where the flag
 * makes the second call a no-op.
 *
 * TODO(registry): server/registry/capabilities/task.ts (registerTaskCapabilities)
 * and server/registry/exemptions.ts (registerRouteExemptions) are being
 * written concurrently by other agents and may not exist yet. The dynamic
 * imports below are deliberately non-literal specifiers (assigned to a
 * `string`-typed local first) so a missing file is a runtime miss caught by
 * the catch block, not a `tsc` module-resolution error. Once both files land,
 * replace this whole function body with static imports:
 *
 *   import { registerTaskCapabilities } from './capabilities/task.js';
 *   import { registerRouteExemptions } from './exemptions.js';
 *   ...
 *   registerTaskCapabilities();
 *   registerRouteExemptions();
 */
export async function installCapabilities(): Promise<void> {
  if (installed) return;
  installed = true;

  const taskCapabilitiesModule: string = './capabilities/task.js';
  try {
    const { registerTaskCapabilities } = await import(taskCapabilitiesModule);
    registerTaskCapabilities();
  } catch (err) {
    logger.debug(
      { operation: 'installCapabilities', module: taskCapabilitiesModule, err: String(err) },
      'capability module not present yet — skipping',
    );
  }

  const exemptionsModule: string = './exemptions.js';
  try {
    const { registerRouteExemptions } = await import(exemptionsModule);
    registerRouteExemptions();
  } catch (err) {
    logger.debug(
      { operation: 'installCapabilities', module: exemptionsModule, err: String(err) },
      'exemptions module not present yet — skipping',
    );
  }
}

/** Test support: allows `installCapabilities()` to run again in a fresh test. Tests only. */
export function resetInstalled(): void {
  installed = false;
}

/**
 * Installs capabilities, then mounts every HTTP-projected capability onto
 * `app` at its declared route. Safe to call with zero capabilities registered
 * — mounting nothing is valid.
 */
export async function mountCapabilityRoutes(app: Express): Promise<void> {
  await installCapabilities();
  const router = express.Router();
  mountCapabilities(router);
  app.use(router);
}

/**
 * Installs capabilities, then registers every MCP-projected capability
 * `caller` is authorized to invoke as a tool on `server`. Safe to call with
 * zero capabilities registered — registering nothing is valid.
 */
export async function registerCapabilityMcpTools(
  server: McpServer,
  caller: CallerClass,
): Promise<void> {
  await installCapabilities();
  registerCapabilityTools(server, { caller });
}

/**
 * Installs capabilities, then registers every CLI-projected capability as a
 * commander subcommand on `program`. Safe to call with zero capabilities
 * registered — registering nothing is valid.
 */
export async function registerCapabilityCli(program: Command): Promise<void> {
  await installCapabilities();
  registerCapabilityCommands(program);
}
