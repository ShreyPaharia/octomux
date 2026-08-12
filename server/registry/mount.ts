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
import { listCliCapabilities } from './index.js';
import type { CallerClass } from './types.js';
import { mountCapabilities } from './projections/http.js';
import { registerCapabilityTools } from './projections/mcp.js';
import type { RegisterCapabilityToolsOptions } from './projections/mcp.js';
import { registerCapabilityCommands } from '@octomux/capabilities';
import { registerTaskCapabilities } from './capabilities/task.js';
import { registerLearningCapabilities } from './capabilities/learning.js';
import { registerRunCapabilities } from './capabilities/run.js';
import { registerRouteExemptions } from './exemptions.js';

const logger = childLogger('registry/mount');

let installed = false;

/**
 * Registers every capability and exemption module. Idempotent — each of the
 * three transport entry points below calls this first, and none of them needs
 * to coordinate with the others about who runs it.
 *
 * Guarded by a module-level flag rather than relying on `defineCapability`'s
 * own duplicate-id guard, which would throw on the second call rather than
 * making it a no-op.
 *
 * Synchronous by design. An earlier version used dynamic imports because these
 * two modules did not exist yet, which forced every caller — and therefore
 * `setupRoutes` and `createOctomuxMcpServer` — to become async. Now that they
 * exist, static imports keep server startup exactly as it was.
 */
export function installCapabilities(): void {
  if (installed) return;
  installed = true;

  registerTaskCapabilities();
  registerLearningCapabilities();
  registerRunCapabilities();
  registerRouteExemptions();

  logger.debug(
    { operation: 'installCapabilities' },
    'capabilities and route exemptions registered',
  );
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
export function mountCapabilityRoutes(app: Express): void {
  installCapabilities();
  const router = express.Router();
  mountCapabilities(router);
  app.use(router);
}

/**
 * Installs capabilities, then registers every MCP-projected capability
 * `caller` is authorized to invoke as a tool on `server`. Safe to call with
 * zero capabilities registered — registering nothing is valid.
 */
export function registerCapabilityMcpTools(
  server: McpServer,
  caller: CallerClass,
  opts: Omit<RegisterCapabilityToolsOptions, 'caller'> = {},
): void {
  installCapabilities();
  registerCapabilityTools(server, { ...opts, caller });
}

/**
 * Installs capabilities, then registers every CLI-projected capability as a
 * commander subcommand on `program`. Safe to call with zero capabilities
 * registered — registering nothing is valid.
 */
export function registerCapabilityCli(program: Command): void {
  installCapabilities();
  registerCapabilityCommands(program, listCliCapabilities());
}
